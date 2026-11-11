import { parse } from 'acorn';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import type { Plugin, Loader } from 'esbuild';
import type { Library, ParseResult } from '@openuidev/lang-core';
import type { WidgetComponent } from './runtime.js';

export interface WidgetClientFeatures {
  specialized: boolean;
  /** Bundled lifecycle implementations; render-only components run in the application. */
  components: string[];
  /** Component styles retained for the initial program and explicitly reserved patches. */
  styles: string[];
  lifecycle: boolean;
  fields: boolean;
  forms: boolean;
  mount: boolean;
  events: boolean;
  text: boolean;
}

/** Unknown callback shapes retain the full context, including aliases/rest/arguments. */
function contextServices(callback: Function | undefined): { fields: boolean; forms: boolean; events: boolean; text: boolean } {
  const full = { fields: true, forms: true, events: true, text: true }, empty = { fields: false, forms: false, events: false, text: false };
  if (!callback) return empty;
  let fn: any;
  const source = callback.toString();
  if (/\barguments\b/.test(source)) return full;
  try { fn = (parse(`(${source})`, { ecmaVersion: 'latest' }).body[0] as any).expression; }
  catch { try { fn = (parse(`({${source}})`, { ecmaVersion: 'latest' }).body[0] as any).expression.properties[0].value; }
    catch { return full; } }
  const parameter = fn.params[0];
  if (!parameter) return empty;
  if (parameter.type !== 'ObjectPattern' || parameter.properties.some((p: any) => p.type === 'RestElement')) return full;
  const keys = parameter.properties.map((p: any) => p.computed ? null : p.key.name ?? p.key.value);
  return keys.includes(null) ? full : { fields: keys.includes('field'), forms: keys.includes('form'), events: keys.includes('on'), text: keys.includes('text') };
}

export function widgetClientFeatures(parsed: ParseResult, library: Library<WidgetComponent>, initialTypes: string[], extra: string[] = [], specialized = true): WidgetClientFeatures {
  const names = new Set([...initialTypes, ...extra]);
  for (const name of extra) if (!Object.hasOwn(library.components, name)) throw new TypeError(`Unknown client component ${name}`);
  const schema = library.toJSONSchema();
  let opaque = false;
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'element') names.add(value.typeName);
    if (value.k === 'Comp') {
      if (Object.hasOwn(library.components, value.name)) names.add(value.name);
      // A custom function returning arbitrary data may manufacture elements.
      const returns = schema.functions?.[value.name]?.returns as any;
      if (Object.hasOwn(library.functions ?? {}, value.name) && !['string', 'number', 'boolean', 'null', 'integer'].includes(returns?.type)) opaque = true;
    }
    for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(visit); else visit(child);
  };
  visit(parsed);
  if (['StateRef', 'RuntimeRef'].includes(parsed.rootExpression?.k ?? '')) opaque = true;
  if (!specialized || opaque) Object.keys(library.components).forEach(name => names.add(name));
  const components = [...names].filter(name => {
    const component = library.components[name]?.component;
    return component?.mount || component?.update;
  }).sort();
  let fields = !specialized, forms = !specialized, events = !specialized, text = !specialized;
  for (const name of components) for (const callback of [library.components[name].component.mount, library.components[name].component.update]) {
    const services = contextServices(callback); fields ||= services.fields; forms ||= services.forms;
    events ||= services.events; text ||= services.text;
  }
  const styles = [...names].filter(name => library.components[name]?.component?.css).sort();
  return { specialized, components, styles, lifecycle: !specialized || components.length > 0, fields, forms, events, text,
    mount: !specialized || components.some(name => !!library.components[name].component.mount) };
}

const pure = (node: any): boolean => !!node && (
  ['Literal', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type) ||
  node.type === 'ArrayExpression' && node.elements.every((n: any) => !n || pure(n)) ||
  node.type === 'ObjectExpression' && node.properties.every((p: any) => p.type === 'Property' && !p.computed && p.kind === 'init' && pure(p.value))
);
const usesReceiver = (node: any): boolean => !!node && typeof node === 'object' &&
  (node.type === 'ThisExpression' || Object.values(node).some(value => Array.isArray(value) ? value.some(usesReceiver) : usesReceiver(value)));

/** Only widget bundles are transformed; application implementations remain intact. */
export function hostClientPlugin(features: WidgetClientFeatures, entry?: string): Plugin {
  return { name: 'widget-client-specialization', setup(build) {
    build.onLoad({ filter: /[\\/]client\.js$/ }, async ({ path }) => {
      if (resolve(path) !== resolve(fileURLToPath(new URL('./client.js', import.meta.url)))) return;
      const source = await readFile(path, 'utf8');
      const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
      const values: Record<string, boolean> = { CLIENT_LIFECYCLE: features.lifecycle, CLIENT_FIELDS: features.fields, CLIENT_FORMS: features.forms,
        CLIENT_MOUNT: features.mount, CLIENT_CLEANUPS: features.mount || features.events, CLIENT_EVENTS: features.events, CLIENT_TEXT: features.text };
      const edits: { start: number; end: number; text: string }[] = [];
      const visit = (node: any) => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'ImportDeclaration' && node.source.value === './client-features.js') { edits.push({ start: node.start, end: node.end, text: '' }); return; }
        if (node.type === 'Identifier' && Object.hasOwn(values, node.name)) { edits.push({ start: node.start, end: node.end, text: String(values[node.name]) }); return; }
        for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
      };
      visit(ast);
      let contents = source;
      for (const edit of edits.sort((a, b) => b.start - a.start)) contents = contents.slice(0, edit.start) + edit.text + contents.slice(edit.end);
      return { contents, loader: 'js' };
    });
    if (!features.specialized || !entry) return;
    build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
      if (resolve(path) !== resolve(entry)) return;
      const original = await readFile(path, 'utf8');
      const extension = extname(path);
      const loader: Loader = extension === '.tsx' ? 'tsx' : extension === '.jsx' ? 'jsx' : /\.[cm]?ts$/.test(extension) ? 'ts' : 'js';
      const source = (await transform(original, { loader, target: 'es2023' })).code;
      const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
      // The registry may be used as an internal dependency (including computed
      // lookups). Keep that module intact rather than break a callback/helper.
      let registryUsed = false;
      const references = (node: any, parent?: any) => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'Identifier' && node.name === 'components' &&
          !(parent?.type === 'VariableDeclarator' && parent.id === node) && parent?.type !== 'ExportSpecifier' &&
          !(parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand)) registryUsed = true;
        for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(child => references(child, node)); else if (value && typeof value === 'object') references(value, node);
      };
      references(ast);
      if (registryUsed) return { contents: source, loader: 'js' };
      const edits: { start: number; end: number; text: string }[] = [];
      for (const top of ast.body as any[]) {
        const declaration = top.declaration ?? top;
        if (declaration.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue;
        for (const item of declaration.declarations) {
          if (item.id.name !== 'components' || item.init?.type !== 'ObjectExpression') continue;
          const properties = item.init.properties.filter((property: any) => {
            if (property.type !== 'Property' || property.computed || property.kind !== 'init') return true;
            const name = property.key.name ?? property.key.value;
            return features.components.includes(name) || !pure(property.value);
          }).map((property: any) => {
            if (property.type !== 'Property' || property.value.type !== 'ObjectExpression') return source.slice(property.start, property.end);
            if (property.value.properties.some((p: any) => p.type === 'Property' &&
              ['mount', 'update'].includes(p.key.name ?? p.key.value) && usesReceiver(p.value))) return source.slice(property.start, property.end);
            const body = property.value.properties.filter((p: any) => p.type !== 'Property' || p.computed ||
              !['render', 'css', 'reactive'].includes(p.key.name ?? p.key.value) || !pure(p.value));
            return source.slice(property.start, property.value.start) + '{' + body.map((p: any) => source.slice(p.start, p.end)).join(',') + '}';
          });
          edits.push({ start: item.init.start, end: item.init.end, text: '{' + properties.join(',') + '}' });
        }
      }
      let contents = source;
      // A module has at most one top-level const binding named components.
      for (const edit of edits) contents = contents.slice(0, edit.start) + edit.text + contents.slice(edit.end);
      return { contents, loader: 'js' };
    });
  } };
}
