import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const result = await build({
  entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian'],
  format: 'cjs', target: 'es2022', outfile: 'main.js', logLevel: 'info', metafile: true,
});
const packages = new Set();
for (const path of Object.keys(result.metafile.outputs['main.js'].inputs)) {
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(path);
  if (match) packages.add(match[1]);
}
const licenses = await Promise.all([...packages].sort().map(async path => {
  const {name, version} = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  const license = await readFile(join(path, 'license'), 'utf8');
  return {name, version, license};
}));
const notices = '\n\n/*! Bundled dependency licenses\n' +
  licenses.map(({name, version, license}) => name + '@' + version + '\n' + license).join('\n').replaceAll('*/', '* /') + '\n*/\n';
await writeFile('main.js', notices, {flag:'a'});
