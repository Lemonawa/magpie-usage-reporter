import { ownsEntry } from './entry.mjs';
import { Reporter, normalizeOptions } from './reporter.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const name = '@lemonawa/magpie-usage-reporter';
const root = path.dirname(fileURLToPath(import.meta.url));
export default {
  id: 'magpie-usage-reporter',
  async server(input, supplied = {}) {
    const options = normalizeOptions(supplied);
    if (!options.enabled) return {};
    // Replaced/disabled hosts can finish other plugins' streams for ten minutes.
    // Recheck our entry so their timer stops before a replacement takes over.
    const stillEnabled = async () => {
      const listFile = path.join(input.directory, 'plugins.json');
      let list;
      try { list = JSON.parse(await fs.readFile(listFile, 'utf8')); }
      catch { return false; }
      let dependencies = {};
      try { dependencies = JSON.parse(await fs.readFile(path.join(input.directory, 'plugins', 'package.json'), 'utf8')).dependencies || {}; }
      catch { /* Local-folder installs do not need a dependency mapping. */ }
      const entry = list.plugins?.find(e => ownsEntry(e.spec, {
        root, directory: input.directory, name, dependencies,
      }));
      return !!entry && !entry.off &&
        JSON.stringify(normalizeOptions(entry.options)) === JSON.stringify(options);
    };
    const reporter = new Reporter({ directory: input.directory, options, stillEnabled });
    await reporter.start();
    const stop = () => { void reporter.stop(); };
    process.stdin.once('end', stop);
    process.once('SIGTERM', stop);
    return {};
  }
};
