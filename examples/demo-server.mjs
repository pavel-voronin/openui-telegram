import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSimple } from '../dist-examples/simple.js';
import { createFull, scenes, staticExample } from '../dist-examples/full.js';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function bridge(id, data) {
  return `<script>
    const callbacks = new Map();
    globalThis.TelegramWidget = {
      chatData: ${JSON.stringify(data).replace(/</g, '\\u003c')}, async ready() {
        const response = await fetch('/state/${id}'); const current = await response.json();
        TelegramWidget.chatData = current.data; callbacks.get('chatDataChanged')?.();
      },
      onEvent(name, callback) { callbacks.set(name, callback); }, offEvent(name) { callbacks.delete(name); },
      async request(data) {
        const response = await fetch('/request/${id}', { method: 'POST', body: data });
        const body = await response.json(); if (!response.ok) throw new Error(body.error);
        return { result: body.data };
      },
      openLink(url) { window.open(url, '_blank', 'noopener,noreferrer'); },
      openTelegramLink(url) { window.open(url, '_blank', 'noopener,noreferrer'); },
    };
    addEventListener('message', event => {
      if (event.origin !== location.origin || event.source !== parent) return;
      TelegramWidget.chatData = event.data.data; callbacks.get('chatDataChanged')?.();
    });
    </script>`;
}
function page(mode, entries) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OpenUI Telegram · ${mode}</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#162137;font:16px system-ui}main{max-width:1180px;margin:auto;padding:32px 20px}
  header{margin-bottom:28px}h1{font-size:32px;margin-bottom:8px}h2{font-size:19px;margin:0 0 8px}p{line-height:1.5;color:#465469}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:20px}.card{background:white;border:1px solid #dce2eb;border-radius:14px;padding:20px}
  iframe{border:1px solid #e4e8ee;border-radius:8px;width:100%;height:270px;background:white}.status{font:13px ui-monospace,monospace;overflow-wrap:anywhere;min-height:20px}
  button{padding:8px 12px;margin:6px 6px 0 0;border:1px solid #b7c5d8;background:#f5f8fd;border-radius:7px;cursor:pointer}button:disabled{opacity:.5}
  details{margin-top:16px}pre{white-space:pre-wrap;font-size:13px;max-height:280px;overflow:auto}
  </style></head><body><main><header><h1>${mode === 'simple' ? 'Your first widget' : 'OpenUI Telegram · capability gallery'}</h1>
  <p>${mode === 'simple' ? 'One template, one button, application-owned state. Click +1, then restart the runtime: the open widget keeps working.' : 'Real generated widget HTML in browser iframes. The local bridge simulates Telegram delivery; native Telegram quotas and gestures still require a device check.'}</p></header>
  <div class="grid">${entries.map(([id, scene]) => `<article class="card" id="card-${id}"><h2>${escape(scene.title)}</h2><p>${escape(scene.note)}</p>
  <iframe title="${escape(scene.title)}" id="widget-${id}" src="/widget/${id}"></iframe><p class="status" id="status-${id}">Ready</p>
  ${[...new Set([...(scene.commands ?? []), ...(id === 'static' ? [] : ['restart'])])].map(command => `<button data-id="${id}" data-command="${command}">${escape(({ restart: 'Restart runtime', patch: 'Patch heading', stream: 'Stream program', update: 'Replace program', overflow: 'Overflow update', replace: 'Send new widget', parser: 'Parser error' })[command])}</button>`).join('')}
  <details><summary>Template and diagnostics</summary><pre>${escape(scene.source ?? 'mode: static; $n = 42')}</pre><pre id="events-${id}"></pre></details></article>`).join('')}</div></main>
  <script>
  const events = new EventSource('/events');
  events.onmessage = event => {
    const {id, kind, data} = JSON.parse(event.data), status = document.getElementById('status-' + id);
    if (kind === 'data') { document.getElementById('widget-' + id).contentWindow.postMessage({data}, location.origin); status.textContent = 'Delivered ' + new TextEncoder().encode(data).length + ' bytes'; }
    else if (kind === 'document') { document.getElementById('widget-' + id).src = '/widget/' + id + '?fresh=' + Date.now(); status.textContent = 'New document sent'; }
    else { status.textContent = data; document.getElementById('events-' + id).textContent = data; }
  };
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-command]'); if (!button) return;
    button.disabled = true;
    try { const response = await fetch('/command/' + button.dataset.id, {method:'POST', body:button.dataset.command}); const body = await response.json(); if (!response.ok) throw new Error(body.error); }
    catch(error) { document.getElementById('status-' + button.dataset.id).textContent = error.message; }
    finally { button.disabled = false; }
  });
  </script></body></html>`;
}

export async function startDemo({ mode = 'simple', port = 0, storage = resolve('.demo-state', mode) } = {}) {
  if (!['simple', 'full'].includes(mode)) throw new Error('Choose simple or full');
  const clients = new Set(), widgets = new Map(), writes = new Map();
  const entries = mode === 'simple' ? [['simple', { title: 'Counter', note: 'State + action + restart', source: 'root = Stack([Text($count), Button("+1", @Set($count, $count + 1))])' }]] : Object.entries(scenes);
  if (storage) await mkdir(storage, { recursive: true });
  async function persist(id) {
    if (!storage || !widgets.has(id)) return;
    const file = join(storage, id + '.json'), state = JSON.stringify(widgets.get(id).save());
    const next = (writes.get(id) ?? Promise.resolve()).then(async () => { await writeFile(file + '.tmp', state); await rename(file + '.tmp', file); });
    writes.set(id, next.catch(() => {})); await next;
  }
  for (const [id] of entries) {
    let saved;
    if (storage) { try { saved = JSON.parse(await readFile(join(storage, id + '.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    const emit = async event => {
      for (const response of clients) response.write('data: ' + JSON.stringify({ id, ...event }) + '\n\n');
      await persist(id);
    };
    const widget = mode === 'simple' ? await createSimple(emit, saved) : await createFull(id, emit, saved);
    widgets.set(id, widget); await persist(id);
  }
  const staticCard = mode === 'full' ? await staticExample() : undefined;
  if (staticCard) entries.unshift(['static', { title: 'Static snapshot', note: 'Variables are substituted at compilation. No library script is included.' }]);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const send = (status, body, type = 'application/json') => { response.writeHead(status, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' }); response.end(type === 'application/json' ? JSON.stringify(body) : body); };
    try {
      if (request.method === 'GET' && url.pathname === '/') return send(200, page(mode, entries), 'text/html');
      if (request.method === 'GET' && url.pathname === '/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); response.write(': connected\n\n');
        for (const [id, widget] of widgets) response.write('data: ' + JSON.stringify({ id, kind: 'data', data: widget.data }) + '\n\n');
        clients.add(response); request.on('close', () => clients.delete(response)); return;
      }
      const [, route, id] = url.pathname.split('/');
      if (route === 'widget' && id === 'static' && staticCard) return send(200, staticCard.html, 'text/html');
      const widget = widgets.get(id); if (!widget) return send(404, { error: 'Unknown widget' });
      if (route === 'state' && request.method === 'GET') return send(200, { data: widget.data });
      if (route === 'widget' && request.method === 'GET')
        return send(200, widget.html.replace('</head>', bridge(id, widget.data) + '</head>'), 'text/html');
      if (request.method !== 'POST') return send(405, { error: 'Use POST' });
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) return send(403, { error: 'Wrong origin' });
      let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 1024) throw new Error('Request too large'); }
      if (route === 'request') { const result = await widget.handle(body); await persist(id); return send(200, result); }
      if (route === 'command') { const data = await widget.command(body); await persist(id); return send(200, { data, diagnostics: widget.diagnostics }); }
      return send(404, { error: 'Unknown route' });
    } catch (error) { send(400, { error: String(error) }); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, widgets, url: `http://127.0.0.1:${server.address().port}`,
    async close() { for (const client of clients) client.end(); for (const widget of widgets.values()) widget.dispose(); await Promise.all(writes.values()); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const demo = await startDemo({ mode: process.argv[2] ?? 'simple', port: Number(process.env.PORT ?? (process.argv[2] === 'full' ? 3211 : 3210)) });
  console.log('Open ' + demo.url + ' — Ctrl+C to stop. State is persisted in .demo-state/.');
  process.once('SIGINT', () => { void demo.close(); }); process.once('SIGTERM', () => { void demo.close(); });
}
