# OpenUI Telegram

Compile OpenUI templates and data into HTML for Telegram Widgets. Define your components, choose a static snapshot or an updatable widget, then send the resulting HTML through your bot.

Requires Node.js **22.15+, 24 or 26 LTS**, Zod 4 and `@openuidev/lang-core` 1.1.0.

```sh
npm install openui-telegram @openuidev/lang-core zod
```

## Static HTML

```ts
import { z } from 'zod';
import { createLibrary } from '@openuidev/lang-core';
import {
  compileWidget, defineWidgetComponent,
  createInterface, createWidgetController,
} from 'openui-telegram';

const Text = defineWidgetComponent({
  name: 'Text', description: 'Text',
  props: z.object({ value: z.string() }),
  render: ({ props, text }) => `<p>${text(props.value)}</p>`,
});
const library = createLibrary({ components: [Text] });
const source = '$amount = 0\nroot = Text("Total: " + $amount)';
const initialState = { state: { $amount: 1200 }, forms: {} };

const card = await compileWidget({
  mode: 'static', library, source, initialState,
});
// card.html contains "Total: 1200", with no library JavaScript.
```

`mode` is required. In `static`, `$variables` and expressions are evaluated once during compilation. Actions and browser lifecycle hooks produce error diagnostics. Queries use supplied saved results or defaults; compilation never calls tools.

Before sending HTML, check `diagnostics` for errors and `fits` for Telegram's document limits. `measurement` reports actual byte sizes and remaining space. Components return trusted HTML; use `text(value)` to escape data.

## Updatable widgets

Using the same library and template:

```ts
const widget = await compileWidget({
  mode: 'updatable', instanceId: 'order', library, source, initialState,
});
const session = createInterface(library, source, {
  instanceId: 'order', initialState: widget.initialData.state,
});
const controller = createWidgetController(session.runtime, {
  initialFrame: widget.initialData.frame,
});

// Send widget.html once. Deliver this string as Telegram chat_data:
const chatData = controller.encode(await controller.frame());

// Later, change application state and deliver the next chat_data:
session.runtime.setState('$amount', 1500);
const nextChatData = controller.encode(await controller.frame());

// In your handler for a widget request routed to this instance:
async function handleRequest(requestData: string) {
  const completed = await controller.handle(requestData);
  const data = controller.encode(await controller.frame());
  return { completed, data }; // Deliver data to Telegram and answer the request.
}

// When the application no longer needs this widget:
// controller.dispose();
```

`updatable` includes a compact client; OpenUI executes in your application. Plain HTML updates need no `clientEntry`. Your application owns the bot, request authorization, delivery and storage. Use a unique instance ID of 1–32 ASCII letters, digits, `_` or `-`, and serialize requests and frame delivery for each instance.

- Pass `onOperation: async ({ tool, args }) => ...` to `createInterface` to execute queries and mutations. `onAction` handles custom actions and conversation events. Subscribe with `session.runtime.subscribe(callback)` to deliver asynchronous query results without waiting for another tap.
- `session.update(source)` replaces a program; `session.patch(source)` edits it while retaining unaffected state and operations. `session.push(chunk, complete)` accepts streamed source.
- To resume an existing message, persist `session.source`, `controller.save()` and `controller.checkpoint()` together. Restore the same instance ID/program version and pass the checkpoint to the new controller; see the [restart recipe](https://github.com/pavel-voronin/openui-telegram/blob/main/examples/README.md#restart-and-delivery). Saved mutations are not replayed.

Working examples: [static HTML](https://github.com/pavel-voronin/openui-telegram/blob/main/examples/hello.ts) and [static/updatable cards](https://github.com/pavel-voronin/openui-telegram/blob/main/examples/cards.ts).

Try `npm run demo:simple` for a counter or `npm run demo:full` for the capability gallery. Both run locally without credentials. [Demo instructions](https://github.com/pavel-voronin/openui-telegram/blob/main/examples/README.md) also cover sending them through a real Telegram bot.

## Components and browser hooks

`defineWidgetComponent` infers props from its Zod schema. Its `render` context provides `text`, `renderNode` for children, `action` for a delegated button attribute, and `field`/`form` for values and validation. Mark bound props with `reactive: ['value']` and register fields during `render`.

For browser behavior such as canvas drawing or pointer controls, add `mount(context)` and/or `update(context)`. They receive the DOM `element` and current props. `context.on(target, event, listener)` manages listeners; `mount` may return a cleanup function. Lifecycle components must render one root element.

Put these implementations in a module exporting `components`, use the same implementations in your component definitions, and pass that module's path as `clientEntry`. See [browser-components.ts](https://github.com/pavel-voronin/openui-telegram/blob/main/examples/browser-components.ts). Keep Zod schemas in the application. Browser helpers are exported from `openui-telegram/client`. Reconciliation applies changes to server-rendered content while preserving locally added DOM and unchanged client-modified attributes; removed roots still dispose their resources.

The compiler includes the client capabilities and component CSS reachable from the initial program, including conditional branches. Reserve hooks and styles needed by later patches with `clientComponents: ['Chart']`, or use `clientSpecialization: false` to retain the full client, registry and styles. An update requiring unreserved hooks or component CSS is rejected before changing the visible frame. The compiler's `css` option is always global. Adding browser code or unreserved styles after sending requires a new widget.

## Telegram limits

HTML must fit **both 32,768 bytes uncompressed and 4,096 bytes compressed**; requests are limited to **64 bytes** and state/answers to **1,024 bytes**. Oversized documents produce diagnostics; oversized encoded updates throw `TransportSizeError`. Delivering a larger view requires an explicit new widget; see the [overflow example](https://github.com/pavel-voronin/openui-telegram/blob/main/examples/README.md#oversized-updates). `fits` checks size only; `unsupported-element` diagnoses known removed tags in initial HTML. Diagnostics do not certify CSS, dynamic DOM or sandbox behavior: test your UI in Telegram.

Inline scripts, styles and assets: widgets cannot fetch network resources. Native keyboard inputs are unavailable. Links must open synchronously from a tap; links after asynchronous work are rejected. Updatable interactions require your application and a Telegram round trip. The built-in client consumes `chatData`, not shared `publicData`. Telegram currently enables production widgets only in private bot chats; other contexts require its test server. This package is ESM-only.

See the [Telegram Widget documentation](https://core.telegram.org/bots/widgets) and [OpenUI language documentation](https://www.openui.com/docs/openui-lang/specification).

## Development

Run `npm ci` and `npm run check`. This builds the library and examples, checks types, runs tests with mandatory 100% line/branch/function coverage, and installs the packed library in a separate consumer project. Package verification needs registry access; compilation and unit tests need no credentials or network.

Source is in `src/`, tests in `test/`, and examples in `examples/`. `npm run build` cleans and regenerates `dist/`. Keep generated output uncommitted and add focused tests for behavior changes. CI runs the same checks on Linux and Windows for supported Node versions, including the minimum 22.15.0 and 24.0.0. CI also runs weekly on Sunday at 20:00 UTC, checking the latest releases in each supported Node branch. See [CHANGELOG.md](https://github.com/pavel-voronin/openui-telegram/blob/main/CHANGELOG.md) for release notes.

Stable releases publish to npm after all CI checks pass when a pushed tag matches `v<package.json version>`. A manual Actions run checks publication with `--dry-run` and never publishes. After the first authenticated publish, configure an npm [trusted publisher](https://docs.npmjs.com/trusted-publishers/) for owner `pavel-voronin`, repository `openui-telegram`, workflow `ci.yml`, no environment, with direct `npm publish` allowed. Later releases use OIDC without an npm token.
