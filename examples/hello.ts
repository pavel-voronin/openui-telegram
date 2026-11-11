import { createLibrary } from '@openuidev/lang-core';
import { z } from 'zod';
import { compileWidget, defineWidgetComponent } from 'openui-telegram';

const Text = defineWidgetComponent({ name: 'Text', description: 'Text',
  props: z.object({ value: z.string() }), render: ({ props, text }) => `<p>${text(props.value)}</p>` });

export function compileHello() {
  return compileWidget({ mode: 'static', library: createLibrary({ components: [Text], root: 'Text' }),
    source: 'root = Text("Hello World!")' });
}
