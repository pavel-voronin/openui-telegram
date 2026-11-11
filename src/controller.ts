import { WidgetRuntime } from './runtime.js';
import type { SavedState } from './runtime.js';
import { encodeTransport, utf8Bytes, TransportSizeError } from './transport.js';
import { createWidgetUpdate } from './wire.js';

export interface WidgetFrame {
  i: string; v: number; r: number; h: string;
  c: ReturnType<WidgetRuntime['clientRecords']>;
  f: Record<string, unknown>; l: Record<string, string>;
  e: Record<string, Record<string, string>>;
  /** CSS dependencies of the rendered components, including render-only components. */
  s?: string[];
}
export type WidgetInput = [instance: string, version: number, revision: number, kind: 'a', action: string] |
  [instance: string, version: number, revision: number, kind: 'v', field: string, value: unknown];

/** Persist together with the current session source and runtime state. */
export interface WidgetCheckpoint {
  instanceId: string; version: number; revision: number; initialFrame?: WidgetFrame;
}

/** No Bot API, timers, retries or storage. The application routes a message to its controller. */
export function createWidgetController(runtime: WidgetRuntime, options: { initialFrame?: WidgetFrame; checkpoint?: WidgetCheckpoint } = {}) {
  const saved = options.checkpoint;
  if (saved && (options.initialFrame || saved.instanceId !== runtime.instanceId || saved.version !== runtime.version ||
    !Number.isSafeInteger(saved.revision) || saved.revision < -1 || saved.initialFrame && saved.initialFrame.r > saved.revision))
    throw new Error('Checkpoint does not match the runtime or delivery revision');
  const initialFrame = saved?.initialFrame ?? options.initialFrame;
  if (initialFrame && (initialFrame.i !== runtime.instanceId || initialFrame.v > runtime.version))
    throw new Error('Bootstrap belongs to a different interface or newer program');
  let revision = saved?.revision ?? initialFrame?.r ?? -1;
  let busy = false;
  return {
    runtime,
    async frame(): Promise<WidgetFrame> {
      const h = await runtime.render();
      const styles = runtime.requiredStyles();
      return { i: runtime.instanceId, v: runtime.version, r: ++revision, h,
        c: runtime.clientRecords(), f: runtime.fieldValues(), e: runtime.formErrors(), l: runtime.nativeLinks,
        ...(styles.length ? { s: styles } : {}) };
    },
    async handle(data: string) {
      const bytes = utf8Bytes(data);
      if (!bytes || bytes > 64) throw new TransportSizeError('request', bytes, 64);
      const input = JSON.parse(data) as WidgetInput;
      if (!Array.isArray(input) || input[0] !== runtime.instanceId || input[1] !== runtime.version || input[2] !== revision)
        throw new Error('Stale input or wrong interface instance/version');
      if (busy) throw new Error('An action is already executing; application controls delivery order');
      busy = true;
      try {
        if (input[3] === 'a' && input.length === 5 && typeof input[4] === 'string') return await runtime.click(input[4]);
        else if (input[3] === 'v' && input.length === 6 && typeof input[4] === 'string') { runtime.setFieldHandle(input[4], input[5]); return true; }
        else throw new Error('Invalid widget input');
      } finally { busy = false; }
    },
    encode(frame: WidgetFrame, base = initialFrame) {
      if (!base) return encodeTransport(frame, 'response');
      const update = createWidgetUpdate(base, frame);
      const delta = JSON.stringify(update), full = JSON.stringify(frame);
      return encodeTransport(utf8Bytes(delta) < utf8Bytes(full) ? update : frame, 'response');
    },
    save(): SavedState { return runtime.snapshot(); },
    checkpoint(): WidgetCheckpoint {
      return structuredClone({ instanceId: runtime.instanceId, version: runtime.version, revision, initialFrame });
    },
    dispose() { runtime.dispose(); },
  };
}
