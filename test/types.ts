import { createLibrary } from '@openuidev/lang-core';
import { z } from 'zod';
import { defineWidgetComponent, type CompileOptions } from 'openui-telegram';
const Typed = defineWidgetComponent({ name: 'Typed', description: '', props: z.object({ count: z.number() }),
  render({ props, text }) {
    // @ts-expect-error The schema retains its inferred props.
    props.unknown;
    const count: number = props.count;
    return text(count);
  },
});
const compilation = { library: createLibrary({ components: [Typed] }), source: 'root = Typed(1)' };
const staticCompilation: CompileOptions = { ...compilation, mode: 'static' };
const updatableCompilation: CompileOptions = { ...compilation, mode: 'updatable', instanceId: 'hello' };
// @ts-expect-error The output mode must be explicit.
const missingMode: CompileOptions = { ...compilation, instanceId: 'hello' };
// @ts-expect-error Updatable widgets need an instance identifier.
const missingInstance: CompileOptions = { ...compilation, mode: 'updatable' };
void staticCompilation; void updatableCompilation; void missingMode; void missingInstance;
