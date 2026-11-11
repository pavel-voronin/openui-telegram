import { z } from 'zod';
import { action, createLibrary } from '@openuidev/lang-core';
import { defineWidgetComponent } from 'openui-telegram';
import { createDemoWidget } from './demo-widget.js';
import type { DemoEvent, DemoSnapshot } from './demo-widget.js';

const Text = defineWidgetComponent({ name: 'Text', description: 'Text', props: z.object({ value: z.string() }),
  render: ({ props, text }) => `<p>${text(props.value)}</p>` });
const Button = defineWidgetComponent({ name: 'Button', description: 'Button', props: z.object({ label: z.string(), action: action() }),
  render: ({ props, text, action }) => `<button ${action(props.action)}>${text(props.label)}</button>` });
const Stack = defineWidgetComponent({ name: 'Stack', description: 'Layout', props: z.object({ children: z.array(z.union([Text.ref, Button.ref])) }),
  render: async ({ props, renderNode }) => `<main>${await renderNode(props.children)}</main>` });
export const simpleLibrary = createLibrary({ components: [Text, Button, Stack] });
export const simpleSource = '$count = 0\nroot = Stack([Text("Count: " + $count), Button("+1", @Set($count, $count + 1))])';

export function createSimple(emit?: (event: DemoEvent) => void | Promise<void>, saved?: DemoSnapshot) {
  return createDemoWidget({ id: 'simple', library: simpleLibrary, source: simpleSource, emit, saved });
}
