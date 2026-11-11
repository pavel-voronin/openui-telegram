import { createParser, createStreamingParser, defineComponent, mergeStatements, parseMessage, markReactive, isReactiveSchema } from '@openuidev/lang-core';
import type { Library, ParseResult } from '@openuidev/lang-core';
import { z } from 'zod';
import { WidgetRuntime, runtimeLibrary } from './runtime.js';
import type { RuntimeOptions, WidgetComponent } from './runtime.js';
import { responseParts } from './message.js';

/** Props stay inferred; all synchronization belongs to WidgetRuntime. */
export function defineWidgetComponent<T extends z.ZodObject>(config: {
  name: string; description: string; props: T;
} & WidgetComponent<z.output<T>>) {
  const { name, description, props, ...component } = config;
  let registered = props;
  const shape = { ...props.shape };
  for (const key of config.reactive ?? []) {
    if (!Object.hasOwn(props.shape, key)) throw new TypeError(`Unknown reactive prop ${name}.${key}`);
    shape[key] = (props.shape[key] as z.ZodType).clone(); markReactive(shape[key]);
  }
  if (config.reactive?.length) registered = props.clone({ ...props.def, shape }, { parent: true }) as T;
  const reactive = Object.keys(registered.shape).filter(key => isReactiveSchema(registered.shape[key]));
  if (reactive.length) component.reactive = reactive;
  return defineComponent<T, WidgetComponent>({ name, description, props: registered, component });
}

export class WidgetSession {
  readonly runtime: WidgetRuntime;
  source: string;
  message: ReturnType<typeof parseMessage>;
  private parser;
  private streamingParser;
  private stream = '';
  private complete = true;
  constructor(readonly library: Library<WidgetComponent>, source: string, options: RuntimeOptions) {
    this.parser = createParser(library.toJSONSchema(), library.root);
    this.streamingParser = createStreamingParser(library.toJSONSchema(), library.root);
    this.source = source;
    this.message = parseMessage(source);
    this.runtime = new WidgetRuntime(runtimeLibrary(library), this.parser.parse(this.message.content), options);
  }
  update(source: string) {
    this.complete = true;
    this.message = parseMessage(source); this.source = source;
    this.runtime.replace(this.parser.parse(this.message.content)); return this.runtime.parsed;
  }
  patch(patch: string) { return this.update(mergeStatements(this.message.content, parseMessage(patch).content)); }
  push(chunk: string, complete = false): ParseResult {
    this.complete = complete;
    this.stream += chunk;
    this.message = parseMessage(this.stream, { streaming: !complete });
    this.source = this.stream;
    const result = this.streamingParser.set(this.message.content, complete);
    this.runtime.replace(result); return result;
  }
  resetStream() { this.stream = ''; }
  get parts() { return responseParts(this.message.content); }
  get diagnostics() {
    return [...(this.complete ? this.runtime.parsed.meta.errors.map(e => ({ ...e, source: 'parser' as const })) : []),
      ...this.runtime.diagnostics];
  }
  /** Stored context is deliberately opt-in, following the OpenUI message protocol. */
  restoreContext(select: (context: unknown) => Parameters<WidgetRuntime['restore']>[0]) {
    this.runtime.restore(select(this.message.context));
  }
  dispose() { this.runtime.dispose(); }
}

export function createInterface(library: Library<WidgetComponent>, source: string, options: RuntimeOptions) {
  return new WidgetSession(library, source, options);
}
