import { z } from 'zod';
import { createLibrary, action, defineAction, defineFunction } from '@openuidev/lang-core';
import { compileWidget, defineWidgetComponent } from 'openui-telegram';
import { fileURLToPath } from 'node:url';
import { createDemoWidget } from './demo-widget.js';
import type { DemoEvent, DemoSnapshot } from './demo-widget.js';
import { components } from './browser-components.js';

const Text = defineWidgetComponent({ name: 'Text', description: 'Text', props: z.object({ value: z.string() }), render: ({ props, text }) => `<p>${text(props.value)}</p>` });
const Button = defineWidgetComponent({ name: 'Button', description: 'Button', props: z.object({ label: z.string(), action: action() }),
  render: ({ props, text, action }) => `<button ${action(props.action, { label: props.label })}>${text(props.label)}</button>` });
const Tap = defineWidgetComponent({ name: 'Tap', description: 'Tap field', props: z.object({ value: z.number() }), ...components.Tap });
const Chart = defineWidgetComponent({ name: 'Chart', description: 'Canvas', props: z.object({ value: z.number() }), ...components.Chart });
const Svg = defineWidgetComponent({ name: 'Svg', description: 'SVG', props: z.object({ value: z.number() }),
  render: ({ props, text }) => `<svg width="180" height="36"><rect width="${text(Math.min(180, Number(props.value) * 12))}" height="36" fill="#1b9865"/></svg>` });
const Status = defineWidgetComponent({ name: 'Status', description: 'Query and form status', props: z.object({}), render({ runtime, form, text }) {
  const snapshot = runtime.querySnapshot;
  return `<p>${text(snapshot.__openui_loading.length ? 'Loading…' : snapshot.__openui_errors.length ? 'Query failed; retry below' : 'Ready')}</p><p>${text(Object.values(form().errors).join(', '))}</p>`;
} });
const Broken = defineWidgetComponent({ name: 'Broken', description: 'Local render error', props: z.object({ fail: z.boolean() }), render({ props }) {
  if (props.fail) throw new Error('Intentional component failure'); return '<p>Component recovered</p>';
} });
const leaf = [Text, Button, Tap, Chart, Svg, Status, Broken];
const Form = defineWidgetComponent({ name: 'Form', description: 'Scoped form', props: z.object({ name: z.string(), children: z.array(z.union(leaf.map(c => c.ref))) }),
  render: ({ props, renderNode }) => renderNode(props.children, { scope: props.name }) });
const Stack = defineWidgetComponent({ name: 'Stack', description: 'Layout', props: z.object({ children: z.array(z.union([...leaf, Form].map(c => c.ref))) }),
  render: async ({ props, renderNode }) => `<section>${await renderNode(props.children)}</section>` });
export const fullLibrary = createLibrary({ components: [...leaf, Form, Stack],
  functions: [defineFunction({ name: 'Twice', description: 'Double', params: z.object({ value: z.number() }), returns: z.number(), fn: ({ value }) => value * 2 })],
  actions: [defineAction({ name: 'Notify', description: 'Application event', params: z.object({}) })],
});
export const scenes = {
  builtins: { title: 'Built-in calculations', note: 'Count, First, Last, Sum, Avg, Min, Max, Sort, Filter, Round, Abs, Floor and Ceil; Each renders computed rows.', source: `root = Stack([Text("Count: " + @Count([1,2,3]) + "; first: " + @First([1,2,3]) + "; last: " + @Last([1,2,3])), Text("Sum: " + @Sum([1,2,3]) + "; avg: " + @Avg([1,2,3]) + "; min: " + @Min([1,2,3]) + "; max: " + @Max([1,2,3])), @Each(@Sort([{n:2},{n:1}], "n"), row, Text("Sort: " + row.n)), @Each(@Filter([{n:2},{n:1}], "n", ">", 1), row, Text("Filter: " + row.n)), Text("Round: " + @Round([1.234,2.345], 2) + "; abs: " + @Abs([-1,2])), Text("Floor: " + @Floor([1.8,-1.2]) + "; ceil: " + @Ceil([1.2,-1.8]))])` },
  state: { title: 'State, conditions, lists and custom functions', note: 'Increase the number, toggle the view, reset. Count and Sum are upstream built-ins.', source: `$n = 1
$show = true
heading = Text("Shared state")
root = Stack([heading, Text("Number: " + $n + "; twice: " + @Twice($n)), Button("+1", @Set($n, $n + 1)), Button("Toggle", @Set($show, !$show)), Button("Reset", @Reset($n)), $show ? Text("Visible") : null, @Each([1, 2, 3], item, Text("Row " + item * $n)), Text("Count: " + @Count([1,2,3]) + "; sum: " + @Sum([1,2,3]))])` },
  graphics: { title: 'Canvas, SVG and local DOM', note: 'Both charts follow the same number. The canvas is created in mount and survives adjacent updates.', source: `$n = 1
$svg = false
root = Stack([Text("Number: " + $n), Button("+1", @Set($n, $n + 1)), Button("Canvas / SVG", @Set($svg, !$svg)), $svg ? Svg($n) : Chart($n)])` },
  query: { title: 'Dependent queries, loading, failure and retry', note: 'Reload runs the first Query. The second receives its result. Failure keeps an error visible; Recover retries. The first query also refreshes every 30 seconds.', source: `$request = {n: 1, fail: false}
first = Query("read", $request, {value: 0, fetches: 0}, 30)
second = Query("dependent", {value: first.value}, {value: 0})
root = Stack([Status(), Text("First: " + first.value + "; dependent: " + second.value), Text("Refresh #" + first.fetches), Button("Reload", @Run(first)), Button("Fail", @Set($request, {n: $request.n + 1, fail: true})), Button("Recover", @Set($request, {n: $request.n + 1, fail: false}))])` },
  mutation: { title: 'Mutation sequences and application events', note: 'Fail must not reset the number. Save resets it only after success, then emits Notify.', source: `$n = 1
$notice = "No event yet"
save = Mutation("save", {value: $n, fail: false})
bad = Mutation("save", {value: $n, fail: true})
root = Stack([Text("Number: " + $n), Button("+1", @Set($n, $n + 1)), Button("Fail", Action([@Run(bad), @Reset($n)])), Button("Save", Action([@Run(save), @Reset($n), @Notify()])), Text("Save: " + save.status + "; fail: " + bad.status), Text($notice)])` },
  form: { title: 'Scoped fields, validation and conversation events', note: 'The +/− buttons are local DOM created in mount. Quantity must be 1–5. Send validates the form and emits ToAssistant.', source: `$quantity = 1
$notice = "No form submitted"
root = Stack([Form("order", [Tap($quantity), Status(), Button("Send", @ToAssistant("Order", {kind: "demo"}))]), Text($notice)])` },
  editing: { title: 'Patch, streaming and restart', note: 'Change the number, then use the host controls below. Restart recreates the application runtime without replacing the open document.', source: `$n = 1
heading = Text("Original program")
root = Stack([heading, Text("Number: " + $n), Button("+1", @Set($n, $n + 1))])`, commands: ['patch', 'stream', 'update', 'restart'] },
  errors: { title: 'Local rendering failure and recovery', note: 'Break removes only the faulty component. Adjacent text and the recovery button keep working. Parser error replaces the program; Replace program recovers it.', source: `$bad = false
root = Stack([Text("This neighbor stays"), Broken($bad), Button("Break / recover", @Set($bad, !$bad))])`, commands: ['parser', 'update'] },
  links: { title: 'Native external and Telegram links', note: 'Each opens directly from its tap. Telegram links use openTelegramLink; no application round trip is needed.', source: `root = Stack([Button("Telegram", @OpenUrl("https://t.me/telegram")), Button("External", @OpenUrl("https://example.com"))])` },
  limits: { title: 'Oversized updates and explicit replacement', note: 'Overflow exceeds 1024 bytes and leaves the last delivered view visible. Send new widget recompiles the full current view.', source: `$payload = "Small update"
root = Text($payload)`, commands: ['overflow', 'replace'] },
} as const;
export type Scene = keyof typeof scenes;

export function createFull(name: Scene, emit?: (event: DemoEvent) => void | Promise<void>, saved?: DemoSnapshot, delay = 600) {
  let fetches = 0;
  return createDemoWidget({ id: name, library: fullLibrary, source: scenes[name].source,
    clientEntry: fileURLToPath(new URL('./browser-components.js', import.meta.url)), emit, saved,
    async onOperation(operation) {
      await new Promise(resolve => setTimeout(resolve, delay));
      if (operation.args.fail) throw new Error('Intentional tool failure');
      if (operation.tool === 'read') return { value: Number(operation.args.n) * 10, fetches: ++fetches };
      if (operation.tool === 'dependent') return { value: Number(operation.args.value) * 2 };
      return { value: operation.args.value };
    },
  });
}
export function staticExample() {
  return compileWidget({ mode: 'static', library: fullLibrary, source: '$n = 42\nroot = Text("Static snapshot: " + $n)' });
}
