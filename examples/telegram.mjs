import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createSimple } from '../dist-examples/simple.js';
import { createFull, scenes, staticExample } from '../dist-examples/full.js';

// A deliberately small private-chat adapter. No bot framework is required.
const token = process.env.TELEGRAM_BOT_TOKEN, chatId = Number(process.env.TELEGRAM_CHAT_ID);
if (!token || !Number.isSafeInteger(chatId) || chatId <= 0)
  throw new Error('Set TELEGRAM_BOT_TOKEN and your private TELEGRAM_CHAT_ID. Never put secrets in source control.');
const storage = resolve('.demo-state', 'telegram'), stateFile = join(storage, 'messages.json');
await mkdir(storage, { recursive: true });
let records = [], offset = 0, stopped = false, persistence = Promise.resolve(), commands = Promise.resolve();
try { ({ records, offset } = JSON.parse(await readFile(stateFile, 'utf8'))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const messages = new Map();
const widgetHeight = kind => ({ simple: 140, graphics: 160, form: 200, state: 300, builtins: 300,
  query: 240, mutation: 240, editing: 160, errors: 180, links: 90, limits: 90 })[kind];
for (const record of records) messages.set(record.messageId, record);
async function api(method, body) {
  const url = `https://api.telegram.org/bot${token}/${method}`, timeout = method === 'getUpdates' ? 30000 : 15000;
  const result = await (await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })).json();
  if (!result.ok) throw new Error(`${method}: ${result.description}`);
  return result.result;
}
function persist() {
  const snapshot = JSON.stringify({ offset, records: [...messages.values()].map(record => ({
    messageId: record.messageId, kind: record.kind, saved: record.widget?.save() ?? record.saved,
  })) });
  const result = persistence.then(async () => { await writeFile(stateFile + '.tmp', snapshot); await rename(stateFile + '.tmp', stateFile); });
  persistence = result.catch(() => {}); return result;
}
async function install(kind, saved, messageId) {
  const emit = async event => {
    if (messages.get(messageId)?.muted) return;
    if (event.kind === 'data' && messageId) {
      for (let attempt = 0; ; attempt++) {
        try {
          await api('editMessageWidgetData', { chat_id: chatId, message_id: messageId, chat_data: event.data });
          break;
        } catch (error) {
          // A lost response may follow a successful edit. Resend the same frame, never the action.
          if (String(error).includes('message is not modified')) break;
          if (attempt >= 2 || !(error instanceof TypeError || error.name === 'TimeoutError')) throw error;
          console.error(`Message ${messageId}: delivery interrupted; retrying the same frame.`);
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
      await persist();
    } else if (event.kind === 'error' && messageId) console.error(`Message ${messageId}: ${event.data}. Use /replace ${messageId}.`);
  };
  const widget = kind === 'simple' ? await createSimple(emit, saved) : await createFull(kind, emit, saved);
  if (!messageId) {
    const caption = kind === 'simple' ? 'Counter · +1 changes the shared number' : scenes[kind].title + '\n' + scenes[kind].note;
    const result = await api('sendWidget', { chat_id: chatId, html: widget.html, chat_data: widget.data, allow_queries: true, height: widgetHeight(kind), caption });
    messageId = result.message_id;
  }
  messages.set(messageId, { messageId, kind, widget }); await widget.flush(); await persist();
  console.log(`${kind}: message ${messageId}`);
}
for (const record of records) await install(record.kind, record.saved, record.messageId);
async function command(text) {
  const [rawName, idText] = text.trim().split(/\s+/), name = rawName.split('@')[0], id = Number(idText);
  if (name === '/simple' || name === '/start') return install('simple');
  if (Object.hasOwn(scenes, name.slice(1))) return install(name.slice(1));
  if (name === '/full') {
    const card = await staticExample();
    await api('sendWidget', { chat_id: chatId, html: card.html, caption: 'Static snapshot', height: 80 });
    for (const kind of Object.keys(scenes)) { await install(kind); await new Promise(resolve => setTimeout(resolve, 1100)); }
    return;
  }
  const record = messages.get(id);
  if (!record) throw new Error('Use /simple or /full, or specify a widget message ID.');
  if (name === '/replace') {
    // Existing source HTML cannot be edited: explicitly send a new message.
    record.muted = true;
    await record.widget.command('replace');
    const result = await api('sendWidget', { chat_id: chatId, html: record.widget.html, chat_data: record.widget.data, allow_queries: true, caption: record.kind, height: widgetHeight(record.kind) });
    const saved = record.widget.save(); record.widget.dispose(); messages.delete(id); await install(record.kind, saved, result.message_id);
  } else await record.widget.command(name.slice(1));
  await persist();
}
if (process.argv[2]) await command(process.argv[2]);
process.once('SIGINT', () => { stopped = true; }); process.once('SIGTERM', () => { stopped = true; });
console.log('Demo bot ready for the configured private chat. Commands: /simple, /query, /state, /graphics, /mutation, /form, /editing, /errors, /links, /limits, /full.');
const pending = new Map(), tasks = new Set();
let advancing = Promise.resolve(), persistenceError;
async function handleUpdate(update) {
  if (update.message?.chat.id === chatId && update.message.chat.type === 'private' && update.message.text?.startsWith('/')) {
    const work = commands.then(() => command(update.message.text));
    commands = work.catch(() => {}); await work;
  }
  const query = update.widget_query;
  if (query) {
    const record = query.chat?.id === chatId && query.from.id === chatId ? messages.get(query.message_id) : undefined;
    let data;
    try {
      if (!record) throw new Error('Unknown or unauthorized message');
      ({ data } = await record.widget.handle(query.data));
    } catch (error) { console.error(String(error)); }
    await api('answerWidgetQuery', { widget_query_id: query.id, ...(data ? { data } : {}) });
  }
}
function track(update) {
  pending.set(update.update_id, false);
  const task = handleUpdate(update).catch(error => console.error(String(error))).then(() => {
    pending.set(update.update_id, true);
    advancing = advancing.then(async () => {
      // Never acknowledge past an earlier unfinished command, even if later queries completed.
      for (const [id, done] of [...pending].sort(([a], [b]) => a - b)) {
        if (!done) break;
        offset = id + 1; pending.delete(id);
      }
      await persist();
    }).catch(error => { persistenceError = error; stopped = true; });
  });
  tasks.add(task); void task.finally(() => tasks.delete(task));
}
async function acknowledgements() {
  let current;
  do { current = advancing; await current; } while (current !== advancing);
  if (persistenceError) throw persistenceError;
}
try {
  let reconnectDelay = 1000;
  while (!stopped) {
    await acknowledgements();
    let updates;
    try {
      updates = await api('getUpdates', { offset, timeout: 10, allowed_updates: ['message', 'widget_query'] });
      reconnectDelay = 1000;
    } catch (error) {
      if (!(error instanceof TypeError) && error.name !== 'TimeoutError') throw error;
      console.error(`Polling connection lost (${error.cause?.code ?? error.name}); retrying in ${reconnectDelay}ms.`);
      await new Promise(resolve => setTimeout(resolve, reconnectDelay));
      reconnectDelay = Math.min(reconnectDelay * 2, 5000); continue;
    }
    for (const update of updates) {
      if (update.update_id >= offset && !pending.has(update.update_id)) track(update);
    }
    // The same unacknowledged batch may be returned immediately while commands are running.
    if (pending.size) await new Promise(resolve => setTimeout(resolve, 100));
  }
} finally {
  await Promise.all(tasks); await acknowledgements();
  for (const record of messages.values()) record.widget?.dispose(); await persistence;
  if (persistenceError) throw persistenceError;
}
