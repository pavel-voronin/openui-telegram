import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this check with npm run check:package');
const work = await mkdtemp(join(tmpdir(), 'openui-package-check-'));
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 10_000_000,
    env: { ...process.env, npm_config_loglevel: 'silent' } });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}
try {
  // prepack must remove old outputs, not merely overwrite known .js files.
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist', '__stale.js'), 'throw new Error("stale build");');
  const [packed] = JSON.parse(run([npm, 'pack', '--json', '--pack-destination', work]));
  const files = packed.files.map(file => file.path);
  for (const file of ['dist/index.js', 'dist/index.d.ts', 'dist/client.js', 'dist/client.d.ts', 'README.md', 'LICENSE']) assert.ok(files.includes(file), file);
  assert.ok(files.every(file => /^(?:dist\/[^/]+\.(?:js|d\.ts)|README\.md|LICENSE|package\.json)$/.test(file)));
  assert.ok(!files.includes('dist/__stale.js'));
  const consumer = join(work, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'widget-package-consumer', private: true, type: 'module' }));
  run([npm, 'install', '--no-audit', '--no-fund', join(work, packed.filename)], consumer);
  await writeFile(join(consumer, 'smoke.mjs'), `
    import assert from 'node:assert/strict';
    import {z} from 'zod';
    import {createLibrary} from '@openuidev/lang-core';
    import {compileWidget,defineWidgetComponent,createInterface,createWidgetController} from 'openui-telegram';
    import {text} from 'openui-telegram/client';
    import {build} from 'esbuild';
    const Text=defineWidgetComponent({name:'Text',description:'',props:z.object({value:z.string()}),render:({props,text})=>'<p>'+text(props.value)+'</p>'});
    const library=createLibrary({components:[Text]}),source='$n = 1\\nroot = Text("" + $n)';
    const snapshot=await compileWidget({mode:'static',library,source});
    assert.match(snapshot.html,/>1</);assert.equal(snapshot.html.includes('<script>'),false);assert.deepEqual(snapshot.diagnostics,[]);
    const compiled=await compileWidget({mode:'updatable',instanceId:'consumer',library,source});
    assert.deepEqual(compiled.diagnostics,[]);assert.ok(compiled.html.includes('<script>'));assert.equal(compiled.measurement.clientRuntime.containsLanguageRuntime,false);
    const session=createInterface(library,source,{instanceId:'consumer'}),controller=createWidgetController(session.runtime,{initialFrame:compiled.initialData.frame});
    session.runtime.setState('$n',2);assert.match((await controller.frame()).h,/>2</);controller.dispose();
    assert.equal(text('<&'), '&lt;&amp;');
    const browser=await build({stdin:{contents:'import {text} from "openui-telegram/client"; globalThis.rendered=text("<");',resolveDir:process.cwd()},platform:'browser',format:'iife',bundle:true,write:false});
    assert.ok(browser.outputFiles[0].text.includes('rendered'));
    console.log('Installed package: static, updatable, controller and browser entry passed.');
  `);
  process.stdout.write(run([join(consumer, 'smoke.mjs')], consumer));
  await writeFile(join(consumer, 'smoke.ts'), `
    import {z} from 'zod';
    import {createLibrary} from '@openuidev/lang-core';
    import {compileWidget,defineWidgetComponent,type CompileOptions} from 'openui-telegram';
    const Text=defineWidgetComponent({name:'Text',description:'',props:z.object({value:z.string()}),render:({props,text})=>text(props.value)});
    const library=createLibrary({components:[Text]});
    const input:CompileOptions={mode:'static',library,source:'root = Text("Hello")'};
    void compileWidget(input);
    // @ts-expect-error Mode is mandatory in the installed declaration too.
    const invalid:CompileOptions={library,source:'root = Text("Hello")'};
    void invalid;
  `);
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true, noEmit: true }, files: ['smoke.ts'] }));
  run([join(root, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')], consumer);
  console.log(`Package declarations and contents passed (${files.length} files).`);
} finally {
  const target = resolve(work);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('openui-package-check-')) throw new Error('Unsafe package-check cleanup');
  await rm(target, { recursive: true, force: true });
}
