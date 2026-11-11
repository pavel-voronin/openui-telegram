import {
  createStore, createQueryManager, evaluate, evaluateRoot, isElementNode,
  markReactive, resolveStateField, parseRules, parseStructuredRules, validate,
} from '@openuidev/lang-core';
import type {
  ActionEvent, ActionPlan, EvaluationContext, Library, OpenUIError, ParseResult,
  StateField, ValidatorFn,
} from '@openuidev/lang-core';
import { mountWidgetClient } from './client.js';
import type { WidgetFrame } from './controller.js';

export type Diagnostic = Omit<OpenUIError, 'source' | 'code'> & {
  source: OpenUIError['source'] | 'transport' | 'platform' | 'compiler'; code: string;
};
export interface Operation {
  id: string; instanceId: string; version: number;
  type: 'query' | 'mutation' | 'action'; tool: string; args: Record<string, unknown>;
}
export interface OperationReply {
  id: string; instanceId: string; version: number; result?: unknown; error?: string;
}
export interface SavedState {
  state: Record<string, unknown>; forms: Record<string, Record<string, unknown>>;
  results?: Record<string, unknown>;
}
export interface ComponentContext<P = any> {
  props: P; statementId?: string; id: string;
  scope?: string;
  renderNode(value: unknown, options?: { scope?: string }): Promise<string>;
  text(value: unknown): string;
  /** Attribute for a delegated click handler. No inline JavaScript or data interpolation. */
  action(value: unknown, options?: { label?: string; form?: string }): string;
  field<T = unknown>(name: string, binding?: unknown, options?: { scope?: string; rules?: unknown }): StateField<T>;
  form(scope?: string): { values: Record<string, unknown>; errors: Record<string, string> };
  runtime: WidgetRuntime;
}
export interface ClientContext<P = any> extends Omit<ComponentContext<P>, 'runtime' | 'renderNode' | 'action'> {
  element: HTMLElement;
  on(target: EventTarget, event: string, handler: EventListener): void;
}
export interface FieldDescriptor { name: string; scope: string; handle: string; reactive: boolean; rules?: unknown }
export interface WidgetComponent<P = any> {
  render(context: ComponentContext<P>): string | Promise<string>;
  /** Runs after insertion; returned cleanup runs before removal or replacement. */
  mount?(context: ClientContext<P>): void | (() => void);
  update?(context: ClientContext<P>): void;
  reactive?: string[];
  css?: string;
}
export interface RuntimeLibrary {
  components: Record<string, WidgetComponent>;
  functions?: EvaluationContext['functions'];
  actions?: EvaluationContext['actions'];
}
export interface RuntimeOptions {
  instanceId: string; version?: number; initialState?: SavedState;
  onOperation?(operation: Operation): unknown | Promise<unknown>;
  onAction?(event: ActionEvent): void | Promise<void>;
  onDiagnostic?(diagnostic: Diagnostic): void;
  validators?: Record<string, ValidatorFn>;
  openUrl?(url: string): void;
  /** Compiler uses defaults without starting tools. Normal instances execute queries. */
  executeQueries?: boolean;
}
function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as T;
  return value;
}
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
function put<T>(record: Record<string, T>, key: string, value: T) {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}
export function text(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]!);
}

export function runtimeLibrary(library: Library<WidgetComponent>): RuntimeLibrary {
  const schema = library.toJSONSchema();
  return {
    components: Object.fromEntries(Object.entries(library.components).map(([name, c]) => [name, c.component])),
    functions: Object.fromEntries(Object.entries(library.functions ?? {}).map(([name, f]) =>
      [name, { ...schema.functions![name], fn: f.fn }])),
    actions: schema.actions,
  };
}

/** Framework-free execution. Parser results come from the official OpenUI parser. */
export class WidgetRuntime {
  readonly store = createStore();
  queries;
  readonly diagnostics: Diagnostic[] = [];
  readonly instanceId: string;
  version: number;
  private sequence = 0;
  private readonly incarnation = Math.random().toString(36).slice(2);
  private disposed = false;
  private program: ParseResult;
  private forms: SavedState['forms'];
  private restoredResults: Record<string, unknown>;
  private fields = new Map<string, { scope: string; name: string; get(): unknown; rules: unknown; binding: unknown }>();
  private fieldSignature = '';
  private listeners = new Set<() => void>();
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; version: number;
    liveVersion: number; type: Operation['type']; tool: string; args: Record<string, unknown>; statementId?: string }>();
  private clicks = new Map<string, { value: unknown; label: string; form?: string }>();
  private context: EvaluationContext;
  private evalLibrary: Library;
  private unsubscribers: (() => void)[];
  private records = new Map<string, { component: WidgetComponent; context: ComponentContext }>();
  private fieldDescriptors = new Map<string, FieldDescriptor[]>();
  private fieldHandles = new Map<string, (value: unknown) => void>();

  constructor(private library: RuntimeLibrary, program: ParseResult, private options: RuntimeOptions) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(options.instanceId)) throw new TypeError('instanceId must be 1–32 ASCII letters, digits, _ or -');
    if (options.version !== undefined && (!Number.isSafeInteger(options.version) || options.version < 1)) throw new TypeError('version must be a positive integer');
    this.instanceId = options.instanceId;
    this.version = options.version ?? 1;
    this.program = program;
    this.forms = clone(options.initialState?.forms ?? {});
    this.restoredResults = clone(options.initialState?.results ?? {});
    this.evalLibrary = { components: Object.fromEntries(Object.entries(library.components).map(([name, c]) => {
      const shape = Object.fromEntries((c.reactive ?? []).map(key => {
        const schema = {}; markReactive(schema); return [key, schema];
      }));
      return [name, { props: { shape } }];
    })) } as unknown as Library;
    this.context = {
      getState: name => this.store.get(name),
      resolveRef: name => {
        return Object.hasOwn(this.restoredResults, name) ? this.restoredResults[name]
          : this.queries.getMutationResult(name) ?? this.queries.getResult(name);
      },
      functions: library.functions, actions: library.actions,
      reportError: message => this.report({ source: 'runtime', code: 'runtime-error', message }),
    };
    this.queries = this.createQueries();
    this.store.initialize(program.stateDeclarations, options.initialState?.state ?? {});
    this.unsubscribers = [this.store.subscribe(() => { this.sync(); this.notify(); }),
      this.queries.subscribe(() => this.queryChanged())];
    this.sync();
  }
  private firingMutation = false;
  private firingMutationId?: string;
  private renderGeneration = 0;
  private queryChanged() {
    for (const statement of this.program.queryStatements)
      if (this.options.executeQueries !== false && !this.queries.isLoading(statement.statementId) &&
        Object.hasOwn(this.queries.getSnapshot(), statement.statementId)) delete this.restoredResults[statement.statementId];
    this.notify();
  }
  private createQueries() {
    return createQueryManager(this.options.executeQueries === false ? null : { callTool: (tool, args) =>
      this.operation(this.firingMutation ? 'mutation' : 'query', tool, args) });
  }
  report(diagnostic: Diagnostic) {
    this.diagnostics.push(diagnostic); this.options.onDiagnostic?.(diagnostic);
  }
  private check() { if (this.disposed) throw new Error('Interface is disposed'); }
  private notify() { if (!this.disposed) for (const listener of this.listeners) listener(); }
  subscribe(listener: () => void) { this.check(); this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private sync() {
    this.queries.registerMutations(this.program.mutationStatements.map(m => ({
      statementId: m.statementId, toolName: String(m.toolAST ? evaluate(m.toolAST, this.context) : ''),
    })));
    this.queries.evaluateStatements(this.program.queryStatements, this.context);
  }
  private operation(type: Operation['type'], tool: string, args: Record<string, unknown>): Promise<unknown> {
    this.check();
    const op: Operation = { id: `${this.instanceId}:${this.incarnation}:${++this.sequence}`, instanceId: this.instanceId,
      version: this.version, type, tool, args };
    const promise = new Promise((resolve, reject) => this.pending.set(op.id,
      { resolve, reject, version: op.version, liveVersion: op.version, type, tool, args, statementId: this.firingMutationId }));
    if (this.options.onOperation) {
      try {
        // Preserve Telegram's tap when the provider invokes request() synchronously.
        const result = this.options.onOperation(op);
        Promise.resolve(result).then(result => this.reply({ ...op, result }),
          error => this.reply({ ...op, error: error instanceof Error ? error.message : String(error) }));
      } catch (error) { this.reply({ ...op, error: String(error) }); }
    } else {
      this.reply({ ...op, error: `No operation provider for ${tool}` });
    }
    return promise;
  }
  reply(reply: OperationReply): boolean {
    if (this.disposed || reply.instanceId !== this.instanceId) return false;
    const pending = this.pending.get(reply.id);
    if (!pending || reply.version !== pending.version || pending.liveVersion !== this.version) return false;
    this.pending.delete(reply.id);
    if (reply.error !== undefined) {
      this.report({ source: 'transport', code: 'operation-error', message: reply.error, toolName: reply.id });
      pending.reject(new Error(reply.error));
    } else pending.resolve(reply.result);
    return true;
  }
  snapshot(): SavedState {
    this.check();
    const results = Object.fromEntries([...this.program.queryStatements, ...this.program.mutationStatements]
      .map(statement => [statement.statementId, this.context.resolveRef(statement.statementId)]));
    return clone({ state: this.store.getSnapshot(), forms: this.forms, results });
  }
  restore(saved: SavedState) {
    this.check(); this.forms = clone(saved.forms);
    this.restoredResults = clone(saved.results ?? {});
    this.store.initialize(this.program.stateDeclarations, saved.state); this.notify();
  }
  setState(name: string, value: unknown) { this.check(); this.store.set(name, value); }
  getState(name: string) { return this.store.get(name); }
  get querySnapshot() { return this.queries.getSnapshot(); }
  get parsed() { return this.program; }
  get hasActions() { return this.clicks.size !== 0; }
  clientRecords() {
    return Object.fromEntries([...this.records].filter(([, r]) => r.component.mount || r.component.update).map(([id, r]) =>
      [id, { type: Object.keys(this.library.components).find(name => this.library.components[name] === r.component)!,
        props: r.context.props, statementId: r.context.statementId, scope: r.context.scope,
        fields: this.fieldDescriptors.get(id) }]));
  }
  requiredStyles() {
    return [...new Set([...this.records.values()].filter(record => record.component.css).map(record =>
      Object.keys(this.library.components).find(name => this.library.components[name] === record.component)!))].sort();
  }
  fieldValues() {
    return Object.fromEntries([...this.fields].map(([key, field]) => [key, field.get()]));
  }
  formErrors() {
    const scopes = new Set([...this.fields.values()].map(field => field.scope));
    return Object.fromEntries([...scopes].flatMap(scope => {
      const errors = this.form(scope).errors;
      return Object.keys(errors).length ? [[scope, errors]] : [];
    }));
  }
  setFieldHandle(handle: string, value: unknown) {
    const setter = this.fieldHandles.get(handle);
    if (!setter) throw new Error('Field handle is no longer present');
    setter(value);
  }
  nativeLink(id: string): string | undefined {
    const click = this.clicks.get(id);
    if (click?.form !== undefined && Object.keys(this.form(click.form).errors).length) return undefined;
    const value = click?.value as ActionPlan | undefined;
    return value?.steps?.length === 1 && value.steps[0].type === 'open_url' ? value.steps[0].url : undefined;
  }
  get nativeLinks() {
    return Object.fromEntries([...this.clicks.keys()].flatMap(id => {
      const url = this.nativeLink(id); return url ? [[id, url]] : [];
    }));
  }
  replace(program: ParseResult, version = this.version + 1) {
    this.check();
    if (!Number.isSafeInteger(version) || version <= this.version) throw new Error('Program version must increase');
    const old = this.program;
    const operations = [...program.queryStatements, ...program.mutationStatements];
    for (const statement of [...old.queryStatements, ...old.mutationStatements])
      if (JSON.stringify(statement) !== JSON.stringify(operations.find(next => next.statementId === statement.statementId)))
        delete this.restoredResults[statement.statementId];
    const changedMutations = new Set(old.mutationStatements.filter(m =>
      JSON.stringify(m) !== JSON.stringify(program.mutationStatements.find(n => n.statementId === m.statementId))).map(m => m.statementId));
    if (changedMutations.size) this.queries.registerMutations(old.mutationStatements.filter(m => !changedMutations.has(m.statementId)).map(m => ({
      statementId: m.statementId, toolName: String(m.toolAST ? evaluate(m.toolAST, this.context) : ''),
    })));
    this.version = version;
    this.program = program;
    this.store.initialize(program.stateDeclarations, {}); this.sync(); this.notify();
    for (const [id, pending] of this.pending) {
      const candidates = pending.type === 'query' ? program.queryStatements : pending.type === 'mutation' ?
        program.mutationStatements.filter(m => !changedMutations.has(m.statementId)) : [];
      const relevant = candidates.some(statement => {
        try { return (statement.toolAST ? evaluate(statement.toolAST, this.context) : '') === pending.tool &&
          (pending.type === 'mutation' ? statement.statementId === pending.statementId :
            JSON.stringify(statement.argsAST ? evaluate(statement.argsAST, this.context) ?? {} : {}) === JSON.stringify(pending.args)); }
        catch { return false; }
      });
      if (relevant) pending.liveVersion = version;
      else { this.pending.delete(id); pending.resolve(undefined); }
    }
  }
  form(scope = '') {
    return this.formFields(scope, this.fields);
  }
  private formFields(scope: string, fields: typeof this.fields) {
    const values = { ...own(this.forms, scope) };
    const errors: Record<string, string> = {};
    for (const field of fields.values()) if (field.scope === scope) {
      put(values, field.name, field.get());
      const rules = typeof field.rules === 'string' || Array.isArray(field.rules)
        ? parseRules(field.rules) : parseStructuredRules(field.rules);
      const error = validate(values[field.name], rules, this.options.validators);
      if (error) put(errors, field.name, error);
    }
    return { values, errors };
  }
  field<T = unknown>(name: string, binding?: unknown, options: { scope?: string; rules?: unknown } = {}): StateField<T> {
    this.check();
    return this.registerField<T>(name, binding, options, this.fields);
  }
  private registerField<T>(name: string, binding: unknown, options: { scope?: string; rules?: unknown }, fields: typeof this.fields): StateField<T> {
    const scope = options.scope ?? '';
    const getter = (key: string) => own(own(this.forms, scope) ?? {}, key);
    const setter = (key: string, value: unknown) => {
      let form = own(this.forms, scope);
      if (!form) { form = {}; put(this.forms, scope, form); }
      put(form, key, value); this.notify();
    };
    const field = resolveStateField<T>(name, binding, this.store, this.context, getter, setter);
    // Resolve again when validating: bindings and store values may have changed since render.
    fields.set(`${scope}\0${name}`, { scope, name, rules: options.rules, binding,
      get: () => resolveStateField(name, binding, this.store, this.context, getter, setter).value });
    return field;
  }
  async trigger(value: unknown, label = '', scope?: string): Promise<boolean> {
    this.check();
    const version = this.version;
    if (scope !== undefined && Object.keys(this.form(scope).errors).length) { this.notify(); return false; }
    const plan = value as ActionPlan | null;
    const steps = plan?.steps;
    if (!steps) return false;
    // A URL after an await has lost the gesture. Reject before running any side effects.
    let asynchronous = false;
    for (const step of steps) {
      if (step.type === 'open_url' && (asynchronous || !this.options.openUrl)) {
        this.report({ source: 'platform', code: 'gesture-required',
          message: '@OpenUrl requires a synchronous tap; use a separate link button.' }); return false;
      }
      if (['run', 'continue_conversation', 'custom_action', 'open_url'].includes(step.type)) asynchronous = true;
    }
    for (const step of steps) {
      if (this.disposed || version !== this.version) return false;
      switch (step.type) {
        case 'set': this.store.set(step.target, evaluate(step.valueAST, this.context)); break;
        case 'reset': for (const target of step.targets) this.store.set(target, this.program.stateDeclarations[target], { pristine: true }); break;
        case 'run': {
          if (step.refType === 'query') this.queries.invalidate([step.statementId]);
          else {
            const mutation = this.program.mutationStatements.find(m => m.statementId === step.statementId);
            if (!mutation) return false;
            delete this.restoredResults[step.statementId];
            this.firingMutation = true;
            this.firingMutationId = step.statementId;
            let execution: Promise<boolean>;
            try { execution = this.queries.fireMutation(step.statementId,
              mutation.argsAST ? evaluate(mutation.argsAST, this.context) as Record<string, unknown> : {}); }
            finally { this.firingMutation = false; this.firingMutationId = undefined; }
            if (!await execution) return false;
          }
          break;
        }
        case 'open_url': this.options.openUrl!(step.url); break;
        case 'continue_conversation':
        case 'custom_action': {
          const event: ActionEvent = {
            type: step.type === 'custom_action' ? step.name : 'continue_conversation',
            params: step.type === 'custom_action' ? step.params : step.context == null ? {} : { context: step.context },
            humanFriendlyMessage: step.type === 'custom_action' ? label : step.message,
            formState: this.form(scope).values, formName: scope,
          };
          if (this.options.onAction) await this.options.onAction(event);
          else await this.operation('action', event.type, event as unknown as Record<string, unknown>);
          break;
        }
      }
    }
    return true;
  }
  async click(id: string) {
    const click = this.clicks.get(id);
    return click ? this.trigger(click.value, click.label, click.form) : false;
  }
  async render(): Promise<string> {
    this.check();
    const generation = ++this.renderGeneration;
    const clicks: typeof this.clicks = new Map();
    const records: typeof this.records = new Map();
    const fieldDescriptors: typeof this.fieldDescriptors = new Map();
    const fieldHandles: typeof this.fieldHandles = new Map();
    const fields: typeof this.fields = new Map();
    const occurrences = new Map<string, number>();
    const errors: OpenUIError[] = [];
    const root = evaluateRoot(this.program, { ctx: this.context, library: this.evalLibrary, store: this.store, errors });
    errors.forEach(e => this.report(e));
    const renderNode = async (value: unknown, options: { scope?: string } = {}, path = '0'): Promise<string> => {
      if (value == null) return '';
      if (Array.isArray(value)) return (await Promise.all(value.map((child, index) => renderNode(child, options, `${path}-${index}`)))).join('');
      if (!isElementNode(value)) {
        if (typeof value === 'object') throw new TypeError('renderNode requires a component or text');
        return text(value);
      }
      const component = this.library.components[value.typeName];
      if (!component) return '';
      const base = `oui-${this.instanceId}-${value.statementId ? 's-' + value.statementId : 'p-' + path}`;
      const occurrence = occurrences.get(base) ?? 0; occurrences.set(base, occurrence + 1);
      const id = base + (occurrence ? `-${occurrence}` : '');
      let childCall = 0;
      const context: ComponentContext = {
        props: value.props, statementId: value.statementId, id, scope: options.scope,
        renderNode: (child, childOptions) => renderNode(child, { ...options, ...childOptions }, `${path}-${childCall++}`), text, runtime: this,
        action: (action, options = {}) => {
          const key = String(clicks.size);
          clicks.set(key, { value: action, label: options.label ?? '', form: options.form ?? context.scope });
          return `data-oui-action="${key}"`;
        },
        field: <T>(name: string, binding?: unknown, options?: { scope?: string; rules?: unknown }) => {
          const scope = options?.scope ?? context.scope;
          const field = this.registerField<T>(name, binding, { ...options, scope }, fields);
          const handle = fieldHandles.size.toString(36);
          fieldHandles.set(handle, value => field.setValue(value as T));
          const descriptors = fieldDescriptors.get(id) ?? [];
          descriptors.push({ name, scope: scope ?? '', handle, reactive: field.isReactive, rules: options?.rules });
          fieldDescriptors.set(id, descriptors);
          return field;
        },
        form: scope => this.formFields(scope ?? options.scope ?? '', fields),
      };
      try {
        const html = await component.render(context);
        records.set(id, { component, context });
        if (!component.mount && !component.update) {
          if (value.statementId && /^\s*<[a-zA-Z][\w:-]*\b/.test(html) &&
            !/^\s*<[^>]*\bdata-oui-(?:component|node)=/.test(html))
            return html.replace(/^(\s*<[a-zA-Z][\w:-]*)\b/, `$1 data-oui-node="${id}"`);
          return html;
        }
        if (!/^\s*<[a-zA-Z][\w:-]*\b/.test(html)) throw new Error('Lifecycle components must render a root element');
        return html.replace(/^(\s*<[a-zA-Z][\w:-]*)\b/, `$1 data-oui-component="${id}"`);
      } catch (error) {
        this.report({ source: 'runtime', code: 'render-error', component: value.typeName,
          statementId: value.statementId, message: String(error) }); return '';
      }
    };
    const html = await renderNode(root);
    if (!this.disposed && generation === this.renderGeneration) {
      this.clicks = clicks; this.records = records;
      this.fieldDescriptors = fieldDescriptors; this.fieldHandles = fieldHandles;
      this.fields = fields;
      const signature = JSON.stringify([...fields].sort(([a], [b]) => a.localeCompare(b))
        .map(([key, field]) => [key, field.binding, field.rules]));
      if (signature !== this.fieldSignature) { this.fieldSignature = signature; this.notify(); }
    }
    return html;
  }
  /** Attach to an existing DOM root. All listeners and component resources are owned here. */
  mount(element: HTMLElement): () => void {
    this.check();
    let stopped = false, scheduled = false, generation = 0;
    let revision = 0;
    let client: ReturnType<typeof mountWidgetClient> | undefined;
    const frame = async (): Promise<WidgetFrame> => ({ i: this.instanceId, v: this.version, r: ++revision,
      h: await this.render(), c: this.clientRecords(), f: this.fieldValues(), e: this.formErrors(), l: {} });
    const draw = async () => {
      const current = ++generation;
      const next = await frame();
      if (stopped || current !== generation) return;
      if (client) client.apply(next);
      else client = mountWidgetClient(next, this.library.components, { root: element,
        openUrl: this.options.openUrl,
        onDiagnostic: diagnostic => this.report(diagnostic as Diagnostic),
        request: async input => {
          if (input[1] !== this.version) throw new Error('Obsolete local action');
          if (input[3] === 'a') {
            if (!await this.click(input[4])) throw new Error('Action did not complete');
          } else this.setFieldHandle(input[4], input[5]);
          return frame();
        },
      });
    };
    const schedule = () => {
      if (scheduled || stopped) return; scheduled = true;
      Promise.resolve().then(() => { scheduled = false; return draw(); }).catch(error =>
        this.report({ source: 'runtime', code: 'render-error', message: String(error) }));
    };
    const unsubscribe = this.subscribe(schedule);
    const stop = () => { stopped = true; generation++; unsubscribe(); client?.dispose(); };
    this.unsubscribers.push(stop); schedule(); return stop;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribers.splice(0).forEach(f => f());
    this.queries.dispose(); this.store.dispose(); this.listeners.clear();
    for (const p of this.pending.values()) p.resolve(undefined);
    this.pending.clear(); this.clicks.clear(); this.records.clear(); this.fields.clear();
    this.fieldDescriptors.clear(); this.fieldHandles.clear();
  }
}
