import { createLibrary, action, defineFunction, defineAction } from '@openuidev/lang-core';
import { z } from 'zod';
import { compileWidget, defineWidgetComponent } from 'openui-telegram';
import { components, functions } from './client-components.js';
import { fileURLToPath } from 'node:url';

const Text = defineWidgetComponent({ name: 'Text', description: 'Text', props: z.object({ value: z.string() }), ...components.Text });
const Button = defineWidgetComponent({ name: 'Button', description: 'Tap action', props: z.object({ label: z.string(), action: action() }), ...components.Button });
const Counter = defineWidgetComponent({ name: 'Counter', description: 'Tap to increment, no keyboard', props: z.object({ name: z.string(), value: z.number() }), ...components.Counter });
const Plot = defineWidgetComponent({ name: 'Plot', description: 'Canvas', props: z.object({ value: z.number() }), ...components.Plot });
const Icon = defineWidgetComponent({ name: 'Icon', description: 'SVG', props: z.object({ value: z.number() }), ...components.Icon });
const Stack = defineWidgetComponent({ name: 'Stack', description: 'Nested content', props: z.object({ children: z.array(z.union([Text.ref, Button.ref, Counter.ref, Plot.ref, Icon.ref])) }), ...components.Stack });
export const library = createLibrary({ components: [Text, Button, Counter, Plot, Icon, Stack], root: 'Stack',
  functions: [defineFunction({ name: 'Twice', description: 'Double a number', params: z.object({ value: z.number() }), returns: z.number(), fn: functions.Twice })],
  actions: [defineAction({ name: 'Notify', description: 'Application event', params: z.object({ message: z.string() }) })],
});
export const source = `$count = 1
$visible = true
data = Query("read", {count: $count}, {value: 0})
save = Mutation("save", {count: $count})
title = Text("Count: " + $count)
edit = Counter("count", $count)
toggle = Button("Toggle", @Set($visible, !$visible))
submit = Button("Save", Action([@Run(save), @Run(data), @Reset($count), @Notify("saved")]))
chart = $visible ? Plot(@Twice($count)) : Icon(data.value)
root = Stack([title, edit, toggle, submit, chart])`;

export function compileFixture(instanceId = 'demo') {
  return compileWidget({ mode: 'updatable', library, source, instanceId,
    clientEntry: fileURLToPath(new URL('./client-components.js', import.meta.url)) });
}
