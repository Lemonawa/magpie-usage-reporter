import path from 'node:path';

// Magpie keeps the original GitHub spec in plugins.json and resolves its
// installed package name via plugins/package.json. Match that mapping too.
export function ownsEntry(spec, { root, directory, name, dependencies = {} }) {
  if (typeof spec !== 'string') return false;
  if (spec === root || spec === `file://${root}` || spec === name || spec.startsWith(`${name}@`)) return true;
  if (dependencies[name] === spec) return true;
  return path.resolve(directory, spec) === root;
}
