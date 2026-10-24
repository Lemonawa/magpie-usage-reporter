(async () => {
  const $ = id => document.getElementById(id);
  const say = s => { $('message').textContent = s; };
  try {
    await magpie.ready;
    let options = await magpie.options.get();
    $('enabled').checked = options.enabled === true;
    $('endpoint').value = options.endpoint || '';
    $('providers').value = (options.includeProviders || ['codex']).join(', ');
    $('interval').value = options.intervalMs || 2000;
    $('backfill').checked = options.backfill !== false;
    async function save(replay = false) {
      const origin = new URL($('endpoint').value.trim());
      if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw Error('请输入完整 HTTP(S) 网关地址，不含路径、账号或参数');
      const providers = $('providers').value.split(',').map(s => s.trim()).filter(Boolean);
      if (!providers.length) throw Error('至少填写一个本地供应商 ID');
      const next = { ...options, enabled: $('enabled').checked, endpoint: origin.origin, includeProviders: providers, intervalMs: Number($('interval').value), backfill: $('backfill').checked };
      if (replay) { next.enabled = true; next.backfillGeneration = String(Date.now()); }
      options = await magpie.options.set(next);
      $('enabled').checked = options.enabled === true;
      say(replay ? '已保存重新补传指令；打开“插件 → 已安装”加载后端，重复记录由 VPS 去重。' : '配置已保存；请打开“插件 → 已安装”加载后端。运行结果见本机 status.json。');
    }
    $('settings').onsubmit = e => { e.preventDefault(); void save().catch(e => say(e.message)); };
    $('replay').onclick = () => { if ($('settings').reportValidity()) void save(true).catch(e => say(e.message)); };
  } catch (e) { say(`无法加载插件配置：${e.message}`); }
})();
