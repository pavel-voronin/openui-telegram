import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createLibrary } from '@openuidev/lang-core';
import { createInterface, defineWidgetComponent } from 'openui-telegram';

test('host form registration ignores fields from an obsolete asynchronous render', async () => {
  const pending = [];
  const Delayed = defineWidgetComponent({ name: 'Delayed', description: '', reactive: ['value'],
    props: z.object({ name: z.string(), value: z.string() }),
    async render({ props, field, text }) {
      await new Promise(resolve => pending.push(resolve));
      const value = field(props.name, props.value, { rules: { required: true } });
      return `<p>${text(value.value)}</p>`;
    },
  });
  const lib = createLibrary({ components: [Delayed] });
  const session = createInterface(lib, '$a = ""\n$b = "OK"\n$second = false\nroot = $second ? Delayed("b", $b) : Delayed("a", $a)', { instanceId: 'fields-race' });
  try {
    const old = session.runtime.render();
    session.runtime.setState('$second', true);
    const current = session.runtime.render();
    pending[1](); await current;
    pending[0](); await old;
    assert.deepEqual(session.runtime.form().values, { b: 'OK' });
    assert.deepEqual(session.runtime.form().errors, {});
    assert.deepEqual(session.runtime.fieldValues(), { '\0b': 'OK' });
  } finally { session.dispose(); }
});