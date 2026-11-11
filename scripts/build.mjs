import { rm, readFile, readdir, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, sep } from 'node:path';

const root = new URL('../', import.meta.url);
const support = process.argv.includes('--support');
// Targets are fixed workspace children, never arbitrary paths from CLI input.
const outputs = support ? ['dist-examples', 'dist-test'] : ['dist'];
const workspace = resolve(fileURLToPath(root));
for (const output of outputs) {
  const target = resolve(workspace, output);
  if (dirname(target) !== workspace) throw new Error('Build output escaped the workspace');
  await rm(target, { recursive: true, force: true });
}
const configs = support ? ['examples/tsconfig.json', 'test/fixtures/tsconfig.json', 'test/tsconfig.json'] : ['tsconfig.json'];
for (const config of configs) {
  const run = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', config], { cwd: fileURLToPath(root), stdio: 'inherit' });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
}
if (!support) {
  const dist = resolve(workspace, 'dist');
  const needed = new Set();
  async function declaration(file) {
    if (!file.startsWith(dist + sep)) throw new Error('Declaration dependency escaped dist');
    if (needed.has(file)) return;
    needed.add(file);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/['"](\.\.?\/[^'"]+\.js)['"]/g))
      await declaration(resolve(dirname(file), match[1].replace(/\.js$/, '.d.ts')));
  }
  const manifest = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8'));
  for (const entry of Object.values(manifest.exports)) await declaration(resolve(workspace, entry.types));
  for (const file of await readdir(dist)) if (file.endsWith('.d.ts') && !needed.has(resolve(dist, file))) await unlink(resolve(dist, file));
}
