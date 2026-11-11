# Run the examples

```sh
npm ci
npm run demo:simple
# Open http://127.0.0.1:3210
npm run demo:full
# Open http://127.0.0.1:3211
```

Use separate terminals if you want both servers running. `PORT` overrides the default. Both bind only to localhost and use the real compiler/client with a browser-only Telegram bridge. Neither command contacts Telegram or needs a token. These demos are application examples, outside the npm package.

## Start here

[simple.ts](simple.ts) defines Text, Button, Stack and a counter template. The button changes application state and delivers an encoded update. No `clientEntry` is needed. `Restart runtime` recreates the runtime while the open iframe keeps working.

[hello.ts](hello.ts) and [cards.ts](cards.ts) are smaller compile-only examples. After `npm run typecheck`, call their exports from `dist-examples/`.

## Capability gallery

[full.ts](full.ts) defines independent widgets so every complete document fits Telegram's limits:

| Widget | What to try |
| --- | --- |
| Static | A substituted variable, with no library script |
| Built-ins | Count, First/Last, Sum/Avg/Min/Max, Sort/Filter, Round/Abs/Floor/Ceil and Each |
| State | Shared state, custom Twice function, Count/Sum, Each, conditionals and Reset |
| Graphics | Canvas created in mount; SVG switching; both retain the same state |
| Query | Dependent requests, loading, reload, periodic refresh, failure and recovery without another tap |
| Mutation | Fail stops Reset; Save succeeds, resets and emits Notify |
| Form | Local +/− buttons, two-way binding, named scope, 1–5 validation and ToAssistant |
| Editing | Change count, Patch, Stream, Replace program, Restart; count survives |
| Errors | Local render failure with working neighbors, recovery and a parser error |
| Links | External and Telegram links, opened synchronously from a tap |
| Limits | Explicit overflow and replacement with a new document |

[browser-components.ts](browser-components.ts) is the `clientEntry` example. Tap and Chart create their controls/canvas inside `mount`; those nodes survive server updates. Chart redraws from current props. Tap registers its field during server render, then uses its short field handle in the client.

Open each card's details to inspect the template and events. The browser bridge is not Telegram's sandbox: actual gesture rules, layout, quotas and native link opening still need desktop/mobile Telegram checks. The library supports chatData; these examples do not implement publicData/shared widgets.

## Restart and delivery

[demo-widget.ts](demo-widget.ts) owns one serialized request/delivery queue per message. It delivers query completion through a runtime subscription, handles rejected actions separately from transport failures, and uses the immutable bootstrap as the delta base. A checkpoint does not persist a pending operation; queries may refetch after restart, mutations are not replayed.

If delivery fails, the demo retains the last confirmed payload. Once transport recovers, a tap from an older revision resynchronizes the presentation with `completed: false`, without replaying that action; the next tap operates on the current frame. The application can also retry delivery with `flush()`. The core controller continues to reject stale requests: this recovery policy belongs to the example application.

Persist all three parts together:

```ts
const saved = {
  source: session.source,
  state: controller.save(),
  delivery: controller.checkpoint(),
};
// Store JSON in your application after delivering a frame.
```

Restore the same message with its original HTML:

```ts
const session = createInterface(library, saved.source, {
  instanceId: saved.delivery.instanceId,
  version: saved.delivery.version,
  initialState: saved.state,
  onOperation: executeTool,
});
const controller = createWidgetController(session.runtime, {
  checkpoint: saved.delivery,
});
const data = controller.encode(await controller.frame());
// Deliver data: its revision advances beyond the last saved revision.
```

The checkpoint holds the revision and original bootstrap. Persist your immutable HTML/message identity as well; never mix a checkpoint with another message or program. `controller.save()` by itself saves OpenUI data, not the delivery protocol. Dispose the old controller before installing its replacement.

The servers store JSON under ignored `.demo-state/simple/` or `.demo-state/full/`. Stop and restart the process, keep the browser open, then reload it or use the counter again. Original HTML and state resume. To start fresh, stop the server and remove that demo's state directory.

## Oversized updates

Delta updates normally use the original bootstrap, so accumulated changes may exceed 1024 bytes even if one recent edit is small. Catch `TransportSizeError`, retain the last delivered view and offer an explicit new widget. The Limits card demonstrates this: Overflow update reports the failure, Send new widget compiles the current full view and replaces the document. Nothing is truncated or silently discarded. In Telegram this sends a new message, since an existing widget's HTML is immutable.

## Real Telegram

[telegram.mjs](telegram.mjs) uses Bot API directly: sendWidget, editMessageWidgetData and answerWidgetQuery. It accepts only your configured private chat and routes widget queries by message ID and sender, not by the tuple's untrusted instance ID. Temporary query answers and durable chat_data are both delivered. Non-successful actions and bad requests are answered without pretending to have completed the action.

Interactive sends, including `/replace`, set `allow_queries: true`; the static snapshot does not need query permission.

Set these environment variables locally, then run:

```sh
# TELEGRAM_BOT_TOKEN: your bot token
# TELEGRAM_CHAT_ID: your own numeric private-chat/user ID
npm run demo:telegram
```

Send `/simple` for the counter or `/full` for the gallery. Use `/query`, `/form`, `/graphics`, `/state`, `/builtins`, `/mutation`, `/editing`, `/errors`, `/links` or `/limits` to open one compact card. The console prints widget message IDs. Commands `/restart ID`, `/patch ID`, `/stream ID`, `/update ID`, `/parser ID`, `/overflow ID` and `/replace ID` exercise the corresponding gallery cards. Use Patch/Stream/Update on Editing, Parser/Update on Errors, and Overflow/Replace on Limits. `/replace ID` sends a new widget message.

The adapter persists source, state, delivery metadata and Telegram message IDs in `.demo-state/telegram/`. Restarting it resumes the existing messages. Use a dedicated test bot without another getUpdates consumer or webhook. Production currently supports private bot chats; shared/public data, groups, inline mode and forwards are outside this example. Credentials must stay outside Git and should never be pasted into source code.

Polling offset advances only past finished handlers and is persisted before the next acknowledgement to Telegram. Later widget queries can complete while a command is running, but do not acknowledge that unfinished command. A crash before completion causes replay after restart; external side effects may repeat. Handled errors are logged before acknowledgement; failed commands are not automatically retried. Production applications need their own idempotency policy.

Polling reconnects after network failures with a 1–5 second backoff, keeping the acknowledged offset. Widget data delivery makes up to three attempts after network failures, resending the identical frame without repeating the action. A lost response followed by “message is not modified” counts as delivered. Persistent failures still require recovery as described above. Message creation and tool side effects are not automatically repeated.

## Native acceptance

On 12 November 2026, an earlier working-tree build was checked in Telegram Desktop 7.4.2 on Windows 11: counter, form validation/submission and preserved local controls, Canvas/SVG, state/calculations/lists, Query/Mutation failure and recovery, component/program error recovery, patch/stream/update, a real bot-process restart with the same message open, overflow/replacement, links and static HTML. The external-link check ended at Telegram's native confirmation showing the correct URL. Static HTML contained no script. Subsequent fixes for component type changes/remounts, form-bound native links and missing patch CSS have regression tests; native acceptance has not been repeated for those changes.

The user also confirmed counter and Query on a phone, then explicitly limited the remaining acceptance to desktop. Other phone scenarios were not checked. Intermittent local Bot API connection failures required a local HTTP transport bridge; network latency and uninterrupted operation were not established by this acceptance. The regular example uses Node's fetch. Automated tests cover reconnects and identical-frame delivery retries without repeating actions; they do not replace native UI checks.
