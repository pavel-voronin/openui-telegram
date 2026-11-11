import type { WidgetFrame, WidgetInput } from './controller.js';
import type { WidgetComponent, ClientContext } from './runtime.js';
import { text } from './client-text.js';
import { applyWidgetUpdate } from './wire-apply.js';
import type { WidgetUpdate } from './wire-apply.js';
import { reconcileDOM, restoreDOM } from './dom.js';
import { CLIENT_LIFECYCLE, CLIENT_FIELDS, CLIENT_FORMS, CLIENT_MOUNT, CLIENT_CLEANUPS, CLIENT_EVENTS, CLIENT_TEXT } from './client-features.js';
export { text } from './client-text.js';

/** The compiler supplies availableStyles; standalone adapters own their CSS unless they supply this manifest. */
export function mountWidgetClient(initial: WidgetFrame, components: Record<string, WidgetComponent>, options?: {
  root: HTMLElement; request(input: WidgetInput): Promise<WidgetFrame | WidgetUpdate>;
  openUrl?(url: string): void; onDiagnostic?(diagnostic: unknown): void;
}, availableStyles?: readonly string[]) {
  const env = options ? undefined : (globalThis as any).TelegramWidget, host = options ?? (globalThis as any).OpenUIHost;
  const root = options?.root ?? document.getElementById('openui-root')!;
  let frame = initial, stopped = false;
  const resources = CLIENT_LIFECYCLE ? new Map<string, { element: Element; type: string; context: ClientContext; cleanup?: (() => void)[]; signature: string }>() : undefined!;
  const errors: unknown[] = [];
  const error = (e: unknown) => { errors.push(e); host?.onDiagnostic?.({ source: 'transport', code: 'client-error', message: String(e) }); };
  const dispose = (id: string) => {
    const resource = resources.get(id)!;
    resources.delete(id);
    if (CLIENT_CLEANUPS) for (const cleanup of resource.cleanup!.reverse()) { try { cleanup(); } catch(e) { error(e); } }
    restoreDOM(resource.element);
  };
  const request = (input: WidgetInput) => {
    const data = JSON.stringify(input);
    const bytes = encodeURIComponent(data).replace(/%[0-9A-F]{2}/g, 'x').length;
    if (bytes > 64) { error(new Error(`Request has ${bytes} bytes, limit is 64`)); return; }
    try {
      const result = env ? env.request(data).then((answer: { result: string | null }) => answer.result && JSON.parse(answer.result)) : host?.request(input);
      Promise.resolve(result).then(update => { if (update) apply(update); }).catch(error);
    } catch (e) { error(e); }
  };
  const draw = () => {
    if (CLIENT_LIFECYCLE) for (const [id, resource] of resources) if (!frame.c[id] || frame.c[id].type !== resource.type) dispose(id);
    reconcileDOM(root, frame.h);
    if (CLIENT_LIFECYCLE) for (const [id, record] of Object.entries(frame.c)) {
      const implementation = components[record.type], element = root.querySelector<HTMLElement>(`[data-oui-component="${id}"]`);
      if (!element || !implementation) { error(new Error(`Missing lifecycle implementation or root: ${record.type}`)); continue; }
      let resource = resources.get(id);
      if (resource && resource.element !== element) { dispose(id); resource = undefined; }
      const fresh = !resource;
      if (!resource) {
        const cleanup: (() => void)[] = CLIENT_CLEANUPS ? [] : undefined!;
        const context = {
          id, props: {}, statementId: record.statementId, scope: record.scope, element,
          ...(CLIENT_TEXT ? { text } : {}),
          ...(CLIENT_FIELDS ? { field: <T>(name: string, _binding?: unknown, options?: { scope?: string }) => {
              const scope = options?.scope ?? context.scope ?? '';
              const slot = frame.c[id]?.fields?.findIndex(field => field.name === name && field.scope === scope) ?? -1;
              if (slot < 0) throw new Error('Register component fields during render before using lifecycle hooks');
              const current = () => {
                const field = frame.c[id]?.fields?.find(field => field.name === name && field.scope === scope) ?? frame.c[id]?.fields?.[slot];
                if (!field) throw new Error('Field is no longer registered');
                return field;
              };
              return {
                get name() { return current().name; },
                get isReactive() { return current().reactive; },
                get value() { const field = current(); return frame.f[`${field.scope}\0${field.name}`] as T; },
                setValue(value: T) {
                  const field = current();
                  request([frame.i, frame.v, frame.r, 'v', field.handle, value]);
                },
              };
          } } : {}),
          ...(CLIENT_FORMS ? { form: (scope = context.scope ?? '') => ({
            values: Object.fromEntries(Object.entries(frame.f).filter(([key]) => key.startsWith(`${scope}\0`))
              .map(([key, value]) => [key.slice(scope.length + 1), value])), errors: Object.hasOwn(frame.e, scope) ? frame.e[scope] : {},
          }) } : {}),
          ...(CLIENT_EVENTS ? { on(target: EventTarget, event: string, handler: EventListener) {
            target.addEventListener(event, handler); cleanup.push(() => target.removeEventListener(event, handler));
          } } : {}),
        } as ClientContext;
        resource = { element, type: record.type, context, ...(CLIENT_CLEANUPS ? { cleanup } : {}), signature: '' };
        resources.set(id, resource);
      }
      // Keep the props object live for listeners installed by mount().
      const props = resource.context.props;
      for (const key of Object.keys(props)) if (!Object.prototype.hasOwnProperty.call(record.props, key)) delete props[key];
      Object.assign(props, record.props);
      resource.context.scope = record.scope; resource.context.statementId = record.statementId;
      const signature = JSON.stringify([record.props, frame.f, frame.e, record.scope]);
      try {
        if (CLIENT_MOUNT && fresh) { const cleanup = implementation.mount?.(resource.context); if (cleanup) resource.cleanup!.push(cleanup); }
        if (fresh || signature !== resource.signature) implementation.update?.(resource.context);
        resource.signature = signature;
      } catch (e) { error(e); }
    }
    if (CLIENT_LIFECYCLE) for (const [id, resource] of resources) if (!root.contains(resource.element)) dispose(id);
  };
  const apply = (update: WidgetFrame | WidgetUpdate) => {
    if (stopped || update.i !== frame.i || update.v < frame.v || update.v === frame.v && update.r <= frame.r) return false;
    const base = 'd' in update && update.b[0] === initial.v && update.b[1] === initial.r ? initial : frame;
    const next = 'd' in update ? applyWidgetUpdate(base, update) : update;
    for (const name of next.s ?? []) if (availableStyles && !availableStyles.includes(name))
      throw new Error(`Styles for ${name} need a new widget; reserve them with clientComponents before compilation`);
    for (const record of Object.values(next.c)) if (!CLIENT_LIFECYCLE || !components[record.type])
      throw new Error(`Component ${record.type} needs a new widget; reserve it with clientComponents before compilation`);
    frame = next;
    draw(); return true;
  };
  const changed = () => { try { if (env.chatData) apply(JSON.parse(env.chatData)); } catch(e) { error(e); } };
  const click = (event: Event) => {
    let node = event.target as Element | null;
    while (node && node !== root) {
      const action = node.getAttribute('data-oui-action');
      if (action !== null) {
        const link = frame.l[action];
        if (link) { try {
          if (env) {
            const telegram = /^https:\/\/(?:t\.me|telegram\.me|telegram\.dog)(?::443)?(?=[/?#]|$)/i.exec(link);
            if (telegram) env.openTelegramLink('https://t.me' + link.slice(telegram[0].length));
            else env.openLink(link);
          } else host?.openUrl?.(link);
        } catch(e) { error(e); } }
        else request([frame.i, frame.v, frame.r, 'a', action]);
        return;
      }
      node = node.parentElement;
    }
  };
  root.addEventListener('click', click); env?.onEvent('chatDataChanged', changed);
  draw(); if (env) changed(); env?.ready?.();
  return { apply, errors, get current() { return frame; },
    dispose() { stopped = true; if (CLIENT_LIFECYCLE) for (const id of [...resources.keys()]) dispose(id);
      root.removeEventListener('click', click); env?.offEvent('chatDataChanged', changed); },
  };
}
