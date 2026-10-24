"""Run against Magpie's unmodified host.js and a local synthetic receiver.
Usage: python3 host.integration.py /path/to/bun /path/to/magpie/internal/plugin/host.js
"""
import http.server, json, os, pathlib, queue, shutil, subprocess, sys, tempfile, threading, time

bun = os.path.abspath(shutil.which(sys.argv[1]) or sys.argv[1])
host_script = os.path.abspath(sys.argv[2])
plugin = pathlib.Path(__file__).resolve().parent.parent
spec = sys.argv[3] if len(sys.argv) > 3 else str(plugin)
seen = {}; posts = []; hosts = []; received_at = []
class Receiver(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        assert self.path == '/v1/magpie/usage/requests'
        assert self.headers['Authorization'] == 'Bearer synthetic-only'
        rows = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        posts.append(rows); records = []
        for i,r in enumerate(rows):
            assert not any(k in r for k in ['session','err','providerAccount','body'])
            status = 'skipped' if r['rid'] in seen else 'accepted'
            seen[r['rid']] = r
            records.append(dict(index=i,rid=r['rid'],status=status))
        received_at.append(time.monotonic())
        body = json.dumps(dict(accepted=sum(r['status']=='accepted' for r in records), skipped=sum(r['status']=='skipped' for r in records), records=records)).encode()
        self.send_response(200); self.end_headers(); self.wfile.write(body)
    def log_message(self,*args): pass
server = http.server.ThreadingHTTPServer(('127.0.0.1',0), Receiver)
threading.Thread(target=server.serve_forever,daemon=True).start()

def until(fn,seconds=6):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        try:
            if fn(): return
        except (FileNotFoundError,json.JSONDecodeError): pass
        time.sleep(.02)
    raise AssertionError('condition timed out')

with tempfile.TemporaryDirectory(prefix='magpie-host-test-') as tmp:
    root=pathlib.Path(tmp)
    (root/'usage-reporter').mkdir()
    (root/'usage-reporter/credentials.json').write_text(json.dumps(dict(token='synthetic-only')))
    (root/'providers.json').write_text(json.dumps(dict(providers=[dict(id='codex'),dict(id='sg',preset='remote-magpie')])))
    (root/'usage.jsonl').write_text('')
    (root/'auth.json').write_text('{}'); (root/'models.json').write_text('{}')
    if spec != str(plugin):
        (root/'plugins').mkdir()
        (root/'plugins/package.json').write_text(json.dumps(dict(dependencies={'@lemonawa/magpie-usage-reporter':spec})))
    options=dict(enabled=True,endpoint=f'http://127.0.0.1:{server.server_port}',includeProviders=['codex','sg'],intervalMs=250,backfill=True)
    def config(off=False):
        (root/'plugins.json').write_text(json.dumps(dict(plugins=[dict(spec=spec,off=off,options=options)])))
    def launch():
        p=subprocess.Popen([bun,'run',host_script],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        hosts.append(p); messages=queue.Queue()
        def drain():
            for line in p.stdout:
                try: messages.put(json.loads(line))
                except json.JSONDecodeError: pass
        threading.Thread(target=drain,daemon=True).start()
        p.stdin.write(json.dumps(dict(id=1,method='init',params=dict(authPath=str(root/'auth.json'),modelsDevPath=str(root/'models.json'),directory=str(root),plugins=[dict(spec=spec,target=str(plugin),options=options)])))+'\n');p.stdin.flush()
        reply=messages.get(timeout=8)
        while reply.get('id')!=1: reply=messages.get(timeout=8)
        assert 'error' not in reply,reply
        assert not reply['result']['plugins'][0].get('error'),reply
        return p
    def append(id,provider='codex'):
        r=dict(t='2026-10-24T08:00:00Z',agent='codex',provider=provider,model='gpt-example',rid=f'r-{id}',**{'in':123,'out':45,'status':200,'session':'not-shared','err':'not-shared','providerAccount':'not-shared'})
        with (root/'usage.jsonl').open('a') as f:f.write(json.dumps(r)+'\n')
    try:
        config(); p=launch()
        until(lambda:(root/'usage-reporter/status.json').exists())
        start=time.monotonic(); append(1); until(lambda:len(seen)==1)
        latency=round((received_at[-1]-start)*1000)
        append(2,'sg'); time.sleep(.6); assert len(seen)==1
        config(off=True)
        until(lambda:not (root/'usage-reporter/run.lock').exists())
        append(3); time.sleep(.6); assert len(seen)==1
        p.stdin.close();p.wait(timeout=5)
        config(); p=launch();until(lambda:len(seen)==2)
        options['backfillGeneration']='manual-replay';config()
        retiring=p
        p=launch()  # new host starts while the retiring host may still own its lock
        until(lambda:json.loads((root/'usage-reporter/state.json').read_text()).get('duplicates',0)>=2)
        retiring.stdin.close();retiring.wait(timeout=5)
        append(4);until(lambda:len(seen)==3)
        print(json.dumps(dict(result='PASS',install_mode='git' if spec != str(plugin) else 'folder',real_magpie_host=True,runtime=subprocess.check_output([bun,'--version'],text=True).strip(),synthetic_unique_calls=len(seen),posts=len(posts),live_latency_ms=latency,checks=['plugin entry loading','background timer','remote exclusion','disable during live host','restart resume','manual replay dedup','overlapping host handoff','privacy allow-list'])))
    finally:
        for p in hosts:
            if p.poll() is None:
                try:p.stdin.close();p.wait(timeout=3)
                except (OSError,subprocess.TimeoutExpired):p.kill();p.wait()
server.shutdown();server.server_close()
