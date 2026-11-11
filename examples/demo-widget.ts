import { compileWidget, createInterface, createWidgetController, TransportSizeError } from 'openui-telegram';
import type { SavedState, WidgetCheckpoint } from 'openui-telegram';
import type { Library } from '@openuidev/lang-core';
import type { WidgetComponent, RuntimeOptions } from 'openui-telegram';

export interface DemoSnapshot {
  html: string; data: string; source: string; state: SavedState; delivery: WidgetCheckpoint;
}
export interface DemoEvent { kind: 'data' | 'document' | 'error' | 'event'; data: string }
export interface DemoOptions {
  id: string; library: Library<WidgetComponent>; source: string; clientEntry?: string;
  initialState?: SavedState; saved?: DemoSnapshot;
  emit?(event: DemoEvent): void | Promise<void>;
  onOperation?: RuntimeOptions['onOperation'];
}

/** Application example: one serialized delivery queue per message, with durable checkpoints. */
export async function createDemoWidget(options: DemoOptions) {
  let session: ReturnType<typeof createInterface>, controller: ReturnType<typeof createWidgetController>;
  let unsubscribe: () => void, stopped = false, scheduled = false, queue = Promise.resolve();
  let html = '', data = '';
  let reported = 0, parserSignature = '';
  const diagnostics: unknown[] = [];
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task); queue = result.then(() => {}, () => {}); return result;
  };
  const emit = (event: DemoEvent) => options.emit?.(event);
  const save = (): DemoSnapshot => ({ html, data, source: session.source, state: controller.save(), delivery: controller.checkpoint() });
  async function publish() {
    const previous = data;
    const frame = await controller.frame();
    const parser = session.diagnostics.filter(diagnostic => diagnostic.source === 'parser');
    const signature = JSON.stringify(parser);
    if (signature !== parserSignature) { diagnostics.push(...parser); parserSignature = signature; }
    try { data = controller.encode(frame); }
    catch (error) { await emit({ kind: 'error', data: String(error) + '. Send a new widget to deliver this larger view.' }); throw error; }
    try { await emit({ kind: 'data', data }); }
    catch (error) { data = previous; throw error; }
    if (diagnostics.length > reported) {
      const fresh = diagnostics.slice(reported); reported = diagnostics.length;
      await emit({ kind: 'event', data: JSON.stringify(fresh) });
    }
    return data;
  }
  function install(saved: DemoSnapshot) {
    html = saved.html;
    data = saved.data;
    session = createInterface(options.library, saved.source, {
      instanceId: saved.delivery.instanceId, version: saved.delivery.version, initialState: saved.state,
      onOperation: options.onOperation, onDiagnostic: diagnostic => diagnostics.push(diagnostic),
      async onAction(event) {
        if (session.runtime.getState('$notice') !== undefined)
          session.runtime.setState('$notice', event.type + ': ' + JSON.stringify(event.formState));
        await emit({ kind: 'event', data: JSON.stringify(event) });
      },
    });
    controller = createWidgetController(session.runtime, { checkpoint: saved.delivery });
    unsubscribe = session.runtime.subscribe(() => {
      if (scheduled || stopped) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!stopped) void serial(publish).catch(() => {});
      });
    });
  }
  async function document(source: string, initialState?: SavedState, version = 1) {
    const compiled = await compileWidget({ mode: 'updatable', library: options.library, source, initialState,
      version, instanceId: options.id, clientEntry: options.clientEntry });
    if (!compiled.fits || compiled.diagnostics.some(d => d.severity !== 'warning'))
      throw new Error(JSON.stringify(compiled.diagnostics));
    install({ html: compiled.html, data: '', source, state: compiled.initialData.state, delivery: {
      instanceId: options.id, version, revision: compiled.initialData.frame.r, initialFrame: compiled.initialData.frame,
    } });
    return compiled;
  }
  if (options.saved) install(options.saved);
  else await document(options.source, options.initialState);
  try { await serial(publish); }
  catch (error) { if (!(error instanceof TransportSizeError)) throw error; }
  await queue;
  function olderInput(data: string) {
    try {
      const input: unknown = JSON.parse(data), current = controller.checkpoint();
      return Array.isArray(input) && input[0] === current.instanceId && Number.isSafeInteger(input[1]) && input[1] >= 1 && input[1] <= current.version &&
        Number.isSafeInteger(input[2]) && input[2] >= 0 && input[2] < current.revision && typeof input[4] === 'string' &&
        (input[3] === 'a' && input.length === 5 || input[3] === 'v' && input.length === 6);
    } catch { return false; }
  }
  return {
    get html() { return html; }, get data() { return data; }, get diagnostics() { return diagnostics; },
    save,
    flush() { return serial(publish); },
    handle(input: string) { return serial(async () => {
      let completed: boolean;
      try { completed = await controller.handle(input); }
      catch (error) {
        if (error instanceof TransportSizeError || !olderInput(input)) throw error;
        // Resynchronize the presentation; never replay an action against changed handles.
        completed = false;
      }
      return { completed, data: await publish() };
    }); },
    command(name: string) { return serial(async () => {
      if (name === 'restart') {
        const saved = JSON.parse(JSON.stringify(save())) as DemoSnapshot;
        unsubscribe(); controller.dispose(); install(saved);
      } else if (name === 'patch') session.patch('heading = Text("Changed with patch")');
      else if (name === 'parser') session.update('root = Unknown()');
      else if (name === 'stream') {
        const source = session.source; session.resetStream();
        for (let i = 0; i < source.length; i += 32) {
          session.push(source.slice(i, i + 32), i + 32 >= source.length);
          await publish(); await new Promise(resolve => setTimeout(resolve, 40));
        }
      } else if (name === 'overflow') session.runtime.setState('$payload', '0123456789'.repeat(180));
      else if (name === 'replace') {
        const source = session.source, state = controller.save(), version = session.runtime.version + 1;
        unsubscribe(); controller.dispose(); await document(source, state, version);
        await emit({ kind: 'document', data: html });
      } else if (name === 'update') session.update(options.source);
      else throw new Error('Unknown command');
      return publish();
    }); },
    dispose() { stopped = true; unsubscribe(); controller.dispose(); },
    async idle() { await queue; },
  };
}
