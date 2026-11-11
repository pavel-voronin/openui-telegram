import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { resolve } from 'node:path';
import type { Library } from '@openuidev/lang-core';
import { createInterface } from './session.js';
import type { Diagnostic, RuntimeOptions, WidgetComponent } from './runtime.js';
import { TELEGRAM_PROFILE } from './transport.js';
import { createWidgetController } from './controller.js';
import { responseParts } from './message.js';
import { createWidgetUpdate } from './wire.js';
import { javascriptData } from './javascript-data.js';
import { hostClientPlugin, widgetClientFeatures } from './host-client-bundle.js';
import type { WidgetClientFeatures } from './host-client-bundle.js';

interface CompileBase extends Omit<RuntimeOptions, 'instanceId'> {
  library: Library<WidgetComponent>; source: string;
  /** Module exporting components (WidgetComponent map) with client lifecycle implementations.
   * Keep schemas on the host; this module and every imported resource are bundled inline. */
  clientEntry?: string;
  /** Default true: include only reachable lifecycle implementations/services. */
  clientSpecialization?: boolean;
  /** Reserve additional lifecycle components for later program updates/patches. */
  clientComponents?: string[];
  css?: string;
}
export type CompileOptions = CompileBase & (
  { mode: 'static'; instanceId?: string } |
  { mode: 'updatable'; instanceId: string }
);
const scriptJSON = javascriptData;

/** Inspect markup, skipping comments and raw script/style content. Not a sandbox validator. */
function unsupportedElements(html: string): string[] {
  const forbidden = new Set(('input select textarea option optgroup fieldset legend datalist output progress meter dialog audio video source track ' +
    'iframe frame frameset object embed link meta base portal template slot math ruby rt rp center font big tt strike nobr').split(' '));
  const found = new Set<string>();
  const tokens = /<!--[\s\S]*?(?:-->|$)|<\/?([a-z][\w:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  let match;
  while ((match = tokens.exec(html))) {
    const tag = match[1]?.toLowerCase();
    if (!tag) continue;
    const closing = match[0].startsWith('</');
    if (closing) continue;
    if (forbidden.has(tag)) found.add(tag);
    if (tag === 'script' || tag === 'style') {
      const close = new RegExp(`</${tag}\\s*>`, 'gi'); close.lastIndex = tokens.lastIndex;
      if (!close.exec(html)) break;
      tokens.lastIndex = close.lastIndex;
    }
  }
  return [...found];
}

export async function compileWidget(options: CompileOptions) {
  if (options.mode !== 'static' && options.mode !== 'updatable') throw new TypeError('mode must be "static" or "updatable"');
  if (options.mode === 'updatable' && !options.instanceId) throw new TypeError('updatable mode requires instanceId');
  const instanceId = options.instanceId ?? 'static';
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(instanceId)) throw new TypeError('instanceId must be 1–32 ASCII letters, digits, _ or -');
  const clientPath = options.clientEntry ? resolve(options.clientEntry) : undefined;
  const diagnostics: Diagnostic[] = [];
  // Compilation never performs external operations. Queries still expose their defaults.
  const session = createInterface(options.library, options.source, {
    instanceId, version: options.version, initialState: options.initialState,
    validators: options.validators,
    executeQueries: false,
    onDiagnostic: d => diagnostics.push(d),
  });
  try {
    const parsed = session.runtime.parsed;
    const frame = await createWidgetController(session.runtime).frame();
    const initialHtml = frame.h;
    diagnostics.push(...parsed.meta.errors.map(error => ({ ...error, source: 'parser' as const })));
    if (parsed.meta.incomplete) diagnostics.push({ source: 'parser', code: 'incomplete', message: 'Program is incomplete' });
    for (const statementId of parsed.meta.unresolved) diagnostics.push({ source: 'parser', code: 'unresolved', statementId, message: `Unresolved reference: ${statementId}` });
    const initialData = { instanceId, version: options.version ?? 1,
      program: parsed, state: session.runtime.snapshot(), frame, clientFeatures: undefined as WidgetClientFeatures | undefined };
    const needsClient = options.mode === 'updatable';
    if (!needsClient) {
      if (session.runtime.hasActions) diagnostics.push({ source: 'compiler', code: 'static-action',
        message: 'Static HTML cannot execute OpenUI actions. Use mode: "updatable" for interactive controls.' });
      for (const component of new Set(Object.values(frame.c).map(record => record.type))) diagnostics.push({
        source: 'compiler', code: 'static-client-hook', component,
        message: `${component} requires client mount/update hooks. Use mode: "updatable" or a render-only component.` });
      if (parsed.queryStatements.length) diagnostics.push({ source: 'compiler', code: 'static-query-snapshot', severity: 'warning',
        message: 'Static compilation does not execute tools or deliver later Query results; it renders supplied saved results or query defaults.' });
      if (options.clientComponents?.length || options.clientSpecialization === false)
        diagnostics.push({ source: 'compiler', code: 'static-client-options',
          message: 'Client capabilities cannot be enabled in mode: "static". Use mode: "updatable".' });
    }
    const selected = widgetClientFeatures(parsed, options.library, Object.values(frame.c).map(record => record.type),
      needsClient ? options.clientComponents : undefined, !needsClient || options.clientSpecialization !== false);
    const hostFeatures = needsClient ? selected : undefined;
    initialData.clientFeatures = hostFeatures;
    let javascript = '';
    let clientRuntime = { bytes: 0, compressedBytes: 0, accuracy: 'standalone-exact',
      scope: 'Library client only; excludes components and bootstrap. Compression is not additive.', containsLanguageRuntime: false };
    const requiresEntry = !!hostFeatures?.components.length;
    if (needsClient && (!requiresEntry || clientPath)) {
      const bootstrap = `
        import { mountWidgetClient } from ${JSON.stringify(fileURLToPath(new URL('./client.js', import.meta.url)))};
        ${!clientPath ? 'const components = {};' : hostFeatures!.specialized ? `import {components as clientComponents} from ${JSON.stringify(clientPath)};
          const components = {${hostFeatures!.components.map(name => `${scriptJSON(name)}:clientComponents[${scriptJSON(name)}]`).join(',')}};` :
          `import { components } from ${JSON.stringify(clientPath)};`}
        globalThis.OpenUIWidget = mountWidgetClient(${scriptJSON(frame)}, components, undefined, ${scriptJSON(hostFeatures!.styles)});
        globalThis.addEventListener('pagehide', () => globalThis.OpenUIWidget.dispose());
      `;
      const bundled = await build({ stdin: { contents: bootstrap, resolveDir: process.cwd(), loader: 'js' },
        bundle: true, write: false, format: 'iife', platform: 'browser', minify: true, target: 'es2023',
        legalComments: 'none', metafile: true, plugins: [hostClientPlugin(hostFeatures!, options.clientEntry)] });
      javascript = bundled.outputFiles[0].text;
      {
        const service = await build({ stdin: { contents: `import {mountWidgetClient} from ${JSON.stringify(fileURLToPath(new URL('./client.js', import.meta.url)))}; globalThis.OpenUIClient=mountWidgetClient;`,
          resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, format: 'iife', platform: 'browser',
          minify: true, target: 'es2023', metafile: true,
          plugins: [hostClientPlugin(hostFeatures!, options.clientEntry)] });
        const code = service.outputFiles[0].text;
        clientRuntime = { ...clientRuntime, bytes: Buffer.byteLength(code), compressedBytes: deflateSync(code, { level: 9 }).length,
          containsLanguageRuntime: Object.keys(service.metafile!.inputs).some(path => path.includes('@openuidev/lang-core')) };
      }
      if (Object.values(bundled.metafile!.outputs).some(output => output.imports.length))
        throw new Error('Widget bundle must not retain external imports');
    } else if (needsClient) diagnostics.push({ source: 'compiler', code: 'client-entry-required',
      message: `Supply clientEntry for client component implementations: ${hostFeatures!.components.join(', ')}. Plain updatable HTML needs no clientEntry.` });
    const css = (options.css ?? '') + selected.styles.map(name => options.library.components[name].component.css).join('\n');
    if (/<\/style/i.test(css)) throw new Error('CSS must not contain a closing style tag');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="openui-root">${initialHtml}</div>${javascript ? `<script>${javascript.replace(/<\/script/gi, '<\\/script')}</script>` : ''}</body></html>`;
    const measurement = {
      html: { bytes: Buffer.byteLength(html), limit: 32768, accuracy: 'exact' },
      compressedHtml: { bytes: deflateSync(html, { level: 9 }).length, limit: 4096, accuracy: 'exact' },
      clientRuntime,
      headroom: { htmlBytes: 32768 - Buffer.byteLength(html), compressedHtmlBytes: 4096 - deflateSync(html, { level: 9 }).length,
        accuracy: 'exact', note: 'Remaining whole-document limits; not a guarantee for any particular added content.' },
      initialData: { bytes: Buffer.byteLength(JSON.stringify(initialData)), accuracy: 'exact' },
      transportFrame: { bytes: Buffer.byteLength(JSON.stringify(createWidgetUpdate(frame, { ...frame, r: frame.r + 1 }))),
        limit: 1024, accuracy: 'exact', encoding: 'delta-from-bootstrap',
        required: needsClient },
      fullFrame: { bytes: Buffer.byteLength(JSON.stringify(frame)), accuracy: 'exact' },
      client: { accuracy: 'client-only', checks: ['DOM nodes', 'CPU', 'memory', 'canvas', 'layout', 'gestures'] },
    };
    for (const [field, measured] of Object.entries(measurement)) if ('limit' in measured && measured.bytes > measured.limit &&
      (!('required' in measured) || measured.required))
      diagnostics.push({ source: field === 'transportFrame' ? 'transport' : 'platform', code: 'size-limit', path: field,
        message: `${field}: ${measured.bytes} bytes exceeds Telegram's ${measured.limit}-byte limit` });
    if (html.includes('\0')) diagnostics.push({ source: 'platform', code: 'invalid-html', message: 'Telegram forbids NUL in HTML' });
    for (const tag of unsupportedElements(initialHtml)) diagnostics.push({ source: 'platform', code: 'unsupported-element', path: tag,
      message: `Telegram profile 1 removes <${tag}>. Use supported HTML or component-defined pointer controls.` });
    if (/<script\b[^>]*\bsrc\s*=|<link\b[^>]*\bhref\s*=|(?:src\s*=\s*["']?|url\(\s*["']?)https?:|@import\b/i.test(html))
      diagnostics.push({ source: 'platform', code: 'network-resource',
        message: 'Telegram does not load network resources. Inline scripts, CSS and data: resources instead.' });
    const fits = measurement.html.bytes <= measurement.html.limit &&
      measurement.compressedHtml.bytes <= measurement.compressedHtml.limit;
    return { mode: options.mode, html, initialData, diagnostics, measurement, fits, profile: TELEGRAM_PROFILE,
      message: session.message, parts: responseParts(session.message.content) };
  } finally { session.dispose(); }
}
