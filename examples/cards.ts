import { z } from 'zod';
import { createLibrary } from '@openuidev/lang-core';
import { compileWidget, createInterface, createWidgetController, defineWidgetComponent } from 'openui-telegram';

const Text = defineWidgetComponent({ name: 'Text', description: 'Text', props: z.object({ value: z.string() }),
  render: ({ props, text }) => `<p>${text(props.value)}</p>` });
const library = createLibrary({ components: [Text] });
const source = '$amount = 0\nroot = Text("Сумма: " + $amount)';
const initialState = (amount: number) => ({ state: { $amount: amount }, forms: {} });

/** One rendered document. No client, bot, clientEntry or application runtime to keep alive. */
export function compileStaticCard(amount: number) {
  return compileWidget({ mode: 'static', library, source, initialState: initialState(amount) });
}

/** Send compiled.html, keep controller in your application, deliver its encoded frames yourself. */
export async function createUpdatableCard(instanceId: string, amount: number) {
  const compiled = await compileWidget({ mode: 'updatable', instanceId, library, source, initialState: initialState(amount) });
  const session = createInterface(library, source, { instanceId, initialState: compiled.initialData.state });
  const controller = createWidgetController(session.runtime, { initialFrame: compiled.initialData.frame });
  const chatData = controller.encode(await controller.frame());
  return { compiled, session, controller, chatData };
}
