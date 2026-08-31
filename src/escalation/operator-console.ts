/**
 * The operator console: a human takes over the *same live session* the
 * automation was driving, acts in it, and hands it back.
 *
 * Raw node:http with the page inlined, on purpose. The interesting part of
 * human-in-the-loop is the control-transfer protocol, not the widgets, and two
 * properties of that protocol are load-bearing and both live here:
 *
 *  - the lease is the *enforcement* point. POST /input is refused unless the
 *    operator actually holds the lease, so a human and the automation can never
 *    be issuing input to one page at the same time;
 *  - typed text is redacted before it is recorded. An operator's keystrokes on a
 *    bank back-office screen are credentials and account numbers; the audit
 *    trail must prove what happened without becoming the leak.
 *
 * No CDN, no external assets: an operator on a locked-down workstation with no
 * egress must still be able to unblock a run.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { InterventionRequest, InterventionResolution, InterventionStore } from './intervention.js';
import type { HumanAction, LeaseState } from '../session/lease.js';

export interface LiveSession {
  surface: import('../surface/surface.js').Surface;
  lease: import('../session/lease.js').ControlLease;
  redactor: { text(s: string): string };
}

export interface OperatorConsoleDeps {
  store: InterventionStore;
  /** Live sessions by sessionId; undefined once a run has finished. */
  resolveSession(sessionId: string): LiveSession | undefined;
}

export interface OperatorConsoleOptions { port: number; host?: string; operatorName?: string }

type Decision = InterventionResolution['decision'];

const DECISIONS: readonly Decision[] = ['resumed', 'completed_manually', 'aborted', 'denied'];
const BODY_LIMIT = 64 * 1024;
const FRAME_MS = 700;

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

function sendError(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { error });
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

/** Rejects with a 400-worthy Error rather than hanging on a truncated body. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
    size += buf.length;
    if (size > BODY_LIMIT) throw new Error('request body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object');
  return parsed as Record<string, unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;

export class OperatorConsole {
  private server: Server | null = null;
  private bound: string | null = null;
  private readonly host: string;
  private readonly operatorName: string;

  constructor(private deps: OperatorConsoleDeps, private opts: OperatorConsoleOptions) {
    this.host = opts.host ?? '127.0.0.1';
    this.operatorName = opts.operatorName ?? 'operator';
  }

  get url(): string { return this.bound ?? `http://${this.host}:${this.opts.port}`; }

  async start(): Promise<{ url: string }> {
    if (this.server) return { url: this.url };
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((e: unknown) => {
        if (!res.headersSent) sendError(res, 500, msgOf(e));
        else res.end();
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.host, () => { server.removeListener('error', reject); resolve(); });
    });
    const addr = server.address() as AddressInfo | string | null;
    const port = addr && typeof addr === 'object' ? addr.port : this.opts.port;
    this.bound = `http://${this.host}:${port}`;
    return { url: this.bound };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
  }

  // -------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://console.local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    if (path === '/' || path === '/index.html') {
      if (method !== 'GET') return sendError(res, 405, `${method} not allowed on ${path}`);
      return sendHtml(res, 200, renderIndex(this.deps.store.list()));
    }

    const m = /^\/i\/([^/]+)(?:\/(state|frame|take|input|resolve))?$/.exec(path);
    if (!m) return sendError(res, 404, `no route for ${path}`);

    const id = decodeURIComponent(m[1] ?? '');
    const leaf = m[2];
    const it = this.deps.store.get(id);
    if (!it) {
      if (!leaf) return sendHtml(res, 404, renderMissing(id));
      return sendError(res, 404, `no such intervention ${id}`);
    }
    const session = this.deps.resolveSession(it.sessionId);

    if (!leaf) {
      if (method !== 'GET') return sendError(res, 405, `${method} not allowed on ${path}`);
      return sendHtml(res, 200, renderDetail(it));
    }

    if (leaf === 'state') {
      if (method !== 'GET') return sendError(res, 405, `${method} not allowed on ${path}`);
      const lease: LeaseState = session ? session.lease.current : it.lease;
      return sendJson(res, 200, { intervention: it, lease, hasSession: Boolean(session) });
    }

    if (leaf === 'frame') {
      if (method !== 'GET') return sendError(res, 405, `${method} not allowed on ${path}`);
      return this.frame(res, session);
    }

    if (method !== 'POST') return sendError(res, 405, `${method} not allowed on ${path}`);
    let body: Record<string, unknown>;
    try { body = await readJson(req); } catch (e) { return sendError(res, 400, `malformed JSON body: ${msgOf(e)}`); }

    if (leaf === 'take') return this.take(res, it, session, body);
    if (leaf === 'input') return this.input(res, session, body);
    return this.resolve(res, it, session, body);
  }

  private async frame(res: ServerResponse, session: LiveSession | undefined): Promise<void> {
    if (!session) return sendError(res, 409, 'session no longer live');
    let png: Buffer;
    try { png = await session.surface.screenshot(); } catch (e) { return sendError(res, 409, `screenshot failed: ${msgOf(e)}`); }
    // An empty buffer means the renderer is blocked (native modal) rather than broken.
    if (!png || png.length === 0) return sendError(res, 409, 'renderer returned no frame — a native dialog is probably blocking it');
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': String(png.length) });
    res.end(png);
  }

  private take(
    res: ServerResponse,
    it: InterventionRequest,
    session: LiveSession | undefined,
    body: Record<string, unknown>,
  ): void {
    if (it.status === 'resolved' || it.status === 'abandoned') return sendError(res, 409, `intervention ${it.id} is already ${it.status}`);
    if (!session) return sendError(res, 409, 'session no longer live');
    if (session.lease.owner === 'operator') {
      return sendError(res, 409, `an operator already holds the lease (${session.lease.current.holder}, epoch ${session.lease.epoch})`);
    }
    const who = str(body['by'])?.trim() || this.operatorName;
    const reason = str(body['reason'])?.trim() || `${it.reason}: ${it.summary}`;
    session.lease.cedeTo('operator:' + who, session.redactor.text(reason));
    const next = this.deps.store.update(it.id, { status: 'operator_in_control', lease: session.lease.current });
    sendJson(res, 200, { ok: true, intervention: next, lease: session.lease.current });
  }

  private async input(res: ServerResponse, session: LiveSession | undefined, body: Record<string, unknown>): Promise<void> {
    if (!session) return sendError(res, 409, 'session no longer live');
    // The one enforcement point: no lease, no input. Without this a stuck
    // automation and a curious operator can interleave clicks on one page.
    if (session.lease.owner !== 'operator') {
      return sendError(res, 403, 'operator does not hold the control lease — take control first');
    }
    const kind = str(body['kind']);
    const at = new Date().toISOString();
    let act: () => Promise<void>;
    let record: HumanAction;

    switch (kind) {
      case 'click': {
        const x = num(body['x']); const y = num(body['y']);
        if (x === undefined || y === undefined) return sendError(res, 400, 'click requires numeric x and y');
        act = () => session.surface.operator.click(x, y);
        record = { at, kind: 'click', detail: `(${Math.round(x)}, ${Math.round(y)})` };
        break;
      }
      case 'type': {
        const text = typeof body['text'] === 'string' ? (body['text'] as string) : undefined;
        if (text === undefined) return sendError(res, 400, 'type requires text');
        act = () => session.surface.operator.typeText(text);
        // Redacted at the boundary, never after: the raw string must not exist
        // anywhere downstream of this line.
        record = { at, kind: 'type', detail: `${text.length} chars: ${session.redactor.text(text).slice(0, 120)}` };
        break;
      }
      case 'key': {
        const key = str(body['key']);
        if (!key) return sendError(res, 400, 'key requires a key name');
        act = () => session.surface.operator.key(key);
        record = { at, kind: 'key', detail: key };
        break;
      }
      case 'scroll': {
        const dx = num(body['dx']) ?? 0; const dy = num(body['dy']) ?? 0;
        act = () => session.surface.operator.scroll(dx, dy);
        record = { at, kind: 'scroll', detail: `dx=${dx} dy=${dy}` };
        break;
      }
      default:
        return sendError(res, 400, `unknown input kind ${JSON.stringify(kind ?? null)}`);
    }

    try {
      await act();
    } catch (e) {
      // A refused input is itself evidence — record the attempt, redacted shape only.
      session.lease.recordHumanAction({ at, kind: 'note', detail: `failed ${record.kind}: ${session.redactor.text(msgOf(e))}` });
      return sendError(res, 502, `surface rejected ${record.kind}: ${msgOf(e)}`);
    }
    session.lease.recordHumanAction(record);
    sendJson(res, 200, { ok: true, lease: session.lease.current, actions: session.lease.recordedHumanActions.length });
  }

  private resolve(
    res: ServerResponse,
    it: InterventionRequest,
    session: LiveSession | undefined,
    body: Record<string, unknown>,
  ): void {
    if (it.status === 'resolved' || it.status === 'abandoned') {
      return sendError(res, 409, `intervention ${it.id} is already ${it.status}`);
    }
    const decision = str(body['decision']) as Decision | undefined;
    if (!decision || !DECISIONS.includes(decision)) {
      return sendError(res, 400, `decision must be one of ${DECISIONS.join(', ')}`);
    }
    const rawNote = typeof body['note'] === 'string' ? (body['note'] as string) : '';
    const note = session ? session.redactor.text(rawNote) : rawNote;
    const by = str(body['by'])?.trim() || `operator:${this.operatorName}`;

    let humanActions: HumanAction[] = it.resolution?.humanActions ?? [];
    let lease = it.lease;
    if (session) {
      if (note) session.lease.recordHumanAction({ at: new Date().toISOString(), kind: 'note', detail: note });
      // Hand the lease back even when the operator finished the work manually:
      // the epoch bump is what tells the automation its old handle is dead.
      session.lease.returnToAutomation('automation', note || decision);
      humanActions = [...session.lease.recordedHumanActions];
      lease = session.lease.current;
    }
    const resolution: InterventionResolution = { at: new Date().toISOString(), by, decision, note, humanActions };
    const next = this.deps.store.update(it.id, {
      status: decision === 'aborted' ? 'abandoned' : 'resolved',
      resolution,
      lease,
    });
    sendJson(res, 200, { ok: true, intervention: next, lease, hadSession: Boolean(session) });
  }
}

// ---------------------------------------------------------------------------
// Pages. Server-rendered text is escaped; everything polled is written with
// textContent, so redacted-but-hostile app text can never become markup.

const CSS = `
:root { color-scheme: dark }
* { box-sizing: border-box }
body { margin: 0; background: #0d1117; color: #c9d1d9;
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace }
a { color: #79c0ff }
header { padding: 10px 14px; border-bottom: 1px solid #30363d; background: #161b22;
  display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap }
h1 { font-size: 14px; margin: 0; letter-spacing: .08em; text-transform: uppercase }
main { padding: 14px; display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap }
table { border-collapse: collapse; width: 100% }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #21262d; vertical-align: top }
th { color: #8b949e; font-weight: 400; text-transform: uppercase; font-size: 11px; letter-spacing: .06em }
tr:hover td { background: #161b22 }
.tag { padding: 1px 6px; border: 1px solid #30363d; border-radius: 2px; font-size: 11px }
.open { color: #d29922; border-color: #d29922 }
.operator_in_control { color: #f85149; border-color: #f85149 }
.resolved { color: #3fb950; border-color: #3fb950 }
.abandoned { color: #8b949e }
.panel { border: 1px solid #30363d; background: #0d1117; padding: 12px; min-width: 320px; flex: 1 1 340px }
.panel h2 { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 8px }
.frame-wrap { border: 1px solid #30363d; background: #010409; padding: 0; flex: 0 0 auto; line-height: 0 }
#frame { display: block; max-width: 100%; cursor: crosshair }
#frame.locked { cursor: not-allowed; opacity: .75 }
#banner { display: none; margin: 0 14px 0; padding: 8px 12px; background: #3d1a1a;
  border: 1px solid #f85149; color: #ffa198 }
dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px }
dt { color: #8b949e }
dd { margin: 0; word-break: break-word }
ul { margin: 4px 0 0; padding-left: 18px }
button { font: inherit; background: #21262d; color: #c9d1d9; border: 1px solid #30363d;
  padding: 5px 10px; cursor: pointer }
button:hover:enabled { border-color: #8b949e }
button:disabled { opacity: .4; cursor: not-allowed }
button.take { border-color: #3fb950; color: #7ee787 }
button.danger { border-color: #f85149; color: #ffa198 }
input[type=text] { font: inherit; background: #010409; color: #c9d1d9; border: 1px solid #30363d; padding: 5px 8px; width: 100% }
.row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap }
#log { margin: 8px 0 0; max-height: 140px; overflow: auto; white-space: pre-wrap; color: #8b949e }
.owner-operator { color: #7ee787 }
.owner-automation { color: #d29922 }
`;

function shell(title: string, body: string, script: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>${body}
<script>${script}</script></body></html>`;
}

function renderMissing(id: string): string {
  return shell('unknown intervention', `<header><h1>operator console</h1></header>
<main><div class="panel"><h2>404</h2><p>No intervention <code>${esc(id)}</code>.</p>
<p><a href="/">back to the queue</a></p></div></main>`, '');
}

function renderIndex(items: InterventionRequest[]): string {
  const rows = items.length
    ? items.map((i) => `<tr>
<td><a href="/i/${encodeURIComponent(i.id)}">${esc(i.id)}</a></td>
<td><span class="tag ${i.status}">${esc(i.status)}</span></td>
<td>${esc(i.reason)}</td>
<td>${esc(i.summary)}</td>
<td>${esc(i.capability ? `${i.capability.name} v${i.capability.version}` : `${i.mode} run ${i.runId}`)}</td>
<td>${esc(i.createdAt)}</td></tr>`).join('')
    : '<tr><td colspan="6">no interventions — the automation is unblocked</td></tr>';

  const body = `<header><h1>operator console</h1><span>${items.length} intervention(s)</span>
<span id="tick">live</span></header>
<main style="display:block"><table><thead><tr>
<th>id</th><th>status</th><th>reason</th><th>summary</th><th>capability</th><th>created</th>
</tr></thead><tbody id="rows">${rows}</tbody></table></main>`;

  // Re-fetch this same page and swap the tbody: no extra route, and the markup
  // stays server-escaped.
  const script = `
setInterval(function () {
  fetch('/', { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (t) {
    var doc = new DOMParser().parseFromString(t, 'text/html');
    var fresh = doc.getElementById('rows');
    if (fresh) document.getElementById('rows').innerHTML = fresh.innerHTML;
    document.getElementById('tick').textContent = 'live ' + new Date().toLocaleTimeString();
  }).catch(function () { document.getElementById('tick').textContent = 'console unreachable'; });
}, 2500);`;
  return shell('operator console', body, script);
}

function renderDetail(it: InterventionRequest): string {
  const body = `<header><h1><a href="/">queue</a> / ${esc(it.id)}</h1>
<span>control: <b id="owner">…</b></span><span id="statusTag" class="tag">…</span>
<span id="tick"></span></header>
<div id="banner"></div>
<main>
  <div class="frame-wrap"><img id="frame" alt="live session view" width="900"></div>
  <div class="panel">
    <h2>why you were called</h2>
    <dl>
      <dt>reason</dt><dd id="reason"></dd>
      <dt>summary</dt><dd id="summary"></dd>
      <dt>capability</dt><dd>${esc(it.capability ? `${it.capability.name} v${it.capability.version}` : it.mode)}</dd>
      <dt>run</dt><dd>${esc(it.runId)} · session ${esc(it.sessionId)}</dd>
      <dt>step</dt><dd id="step"></dd>
      <dt>locus</dt><dd id="locus"></dd>
      <dt>lease</dt><dd id="lease"></dd>
    </dl>
    <h2 style="margin-top:12px">asked for</h2><ul id="askedFor"></ul>
    <h2 style="margin-top:12px">permitted</h2><ul id="permitted"></ul>
  </div>
  <div class="panel">
    <h2>control</h2>
    <div class="row"><button id="take" class="take">Take control</button></div>
    <div class="row"><input type="text" id="text" placeholder="text to type into the live page" data-needs-control>
    </div>
    <div class="row">
      <button id="send" data-needs-control>Send text</button>
      <button class="k" data-key="Enter" data-needs-control>Enter</button>
      <button class="k" data-key="Tab" data-needs-control>Tab</button>
      <button class="k" data-key="Escape" data-needs-control>Escape</button>
      <button class="s" data-dy="-400" data-needs-control>Scroll up</button>
      <button class="s" data-dy="400" data-needs-control>Scroll down</button>
    </div>
    <h2 style="margin-top:14px">hand back</h2>
    <div class="row"><input type="text" id="note" placeholder="note for the audit trail (redacted)"></div>
    <div class="row">
      <button id="resumed" data-needs-control>Resume automation</button>
      <button id="completed_manually" data-needs-control>I completed it manually</button>
      <button id="aborted" class="danger">Abort run</button>
    </div>
    <h2 style="margin-top:14px">activity</h2>
    <pre id="log"></pre>
  </div>
</main>`;

  const script = `
var ID = ${JSON.stringify(it.id)};
var API = '/i/' + encodeURIComponent(ID) + '/';
var canAct = false, prevBlob = null;

function el(id) { return document.getElementById(id); }
function put(id, v) { el(id).textContent = v == null ? '—' : String(v); }
function log(line) {
  var p = el('log');
  p.textContent = new Date().toLocaleTimeString() + '  ' + line + '\\n' + p.textContent;
}
function banner(m) {
  var b = el('banner');
  b.textContent = m || '';
  b.style.display = m ? 'block' : 'none';
}
function fill(id, arr) {
  var ul = el(id);
  ul.textContent = '';
  (arr || []).forEach(function (v) { var li = document.createElement('li'); li.textContent = String(v); ul.appendChild(li); });
}
function errOf(r) {
  return r.json().then(function (j) { return (j && j.error) || ('HTTP ' + r.status); },
                       function () { return 'HTTP ' + r.status; });
}

function pullFrame() {
  fetch(API + 'frame?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
    if (!r.ok) return errOf(r).then(function (e) { throw new Error(e); });
    return r.blob();
  }).then(function (b) {
    var u = URL.createObjectURL(b), dead = prevBlob;
    prevBlob = u;
    var img = el('frame');
    img.onload = function () { if (dead) URL.revokeObjectURL(dead); };
    img.src = u;
    banner('');
  }).catch(function (e) {
    banner('LIVE VIEW UNAVAILABLE — ' + e.message + ' (controls still work if you hold the lease)');
  });
}

function pullState() {
  return fetch(API + 'state', { cache: 'no-store' }).then(function (r) {
    if (!r.ok) return errOf(r).then(function (e) { throw new Error(e); });
    return r.json();
  }).then(function (d) {
    var i = d.intervention, l = d.lease || {};
    put('owner', l.owner + ' @epoch ' + l.epoch + (l.holder ? ' (' + l.holder + ')' : ''));
    el('owner').className = 'owner-' + l.owner;
    var tag = el('statusTag');
    tag.textContent = i.status;
    tag.className = 'tag ' + i.status;
    put('reason', i.reason);
    put('summary', i.summary);
    put('step', i.step ? i.step.id + ' · ' + i.step.action + ' · ' + i.step.intent + (i.step.target ? ' → ' + i.step.target : '') : 'no step (discovery)');
    put('locus', i.state && i.state.locus);
    put('lease', (l.reason || '') + ' since ' + l.since);
    fill('askedFor', i.askedFor);
    fill('permitted', (i.permitted ? i.permitted.actions : []).concat((i.permitted ? i.permitted.loci : []).map(function (x) { return 'locus: ' + x; })));
    var finished = i.status === 'resolved' || i.status === 'abandoned';
    canAct = Boolean(d.hasSession) && l.owner === 'operator' && !finished;
    var nodes = document.querySelectorAll('[data-needs-control]');
    for (var n = 0; n < nodes.length; n++) nodes[n].disabled = !canAct;
    el('take').disabled = !d.hasSession || l.owner === 'operator' || finished;
    el('aborted').disabled = finished;
    el('frame').className = canAct ? '' : 'locked';
    if (!d.hasSession) banner('SESSION NO LONGER LIVE — this run has ended; you can still read the record' + (finished ? '.' : ' and abort it.'));
    el('tick').textContent = 'polled ' + new Date().toLocaleTimeString();
  }).catch(function (e) { banner('CONSOLE STATE UNAVAILABLE — ' + e.message); });
}

function post(leaf, body) {
  return fetch(API + leaf, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  }).then(function (r) {
    if (!r.ok) return errOf(r).then(function (e) { log('REFUSED ' + leaf + ': ' + e); });
    log('ok ' + leaf + ' ' + (body.kind || body.decision || ''));
  }, function (e) { log('REFUSED ' + leaf + ': ' + e.message); }).then(function () {
    return pullState().then(pullFrame);
  });
}

el('frame').addEventListener('click', function (ev) {
  if (!canAct) { log('not in control — take control first'); return; }
  var img = ev.currentTarget;
  if (!img.naturalWidth || !img.clientWidth) return;
  // Map display pixels back to viewport CSS pixels so the operator hits the
  // real control even if the browser scaled the frame down.
  var x = Math.round(ev.offsetX * img.naturalWidth / img.clientWidth);
  var y = Math.round(ev.offsetY * img.naturalHeight / img.clientHeight);
  post('input', { kind: 'click', x: x, y: y });
});

el('take').addEventListener('click', function () {
  post('take', { reason: el('note').value || undefined });
});
el('send').addEventListener('click', function () {
  var t = el('text').value;
  if (!t) return;
  el('text').value = '';
  post('input', { kind: 'type', text: t });
});
el('text').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') el('send').click(); });
var keys = document.querySelectorAll('button.k');
for (var a = 0; a < keys.length; a++) keys[a].addEventListener('click', function (ev) {
  post('input', { kind: 'key', key: ev.currentTarget.getAttribute('data-key') });
});
var scrolls = document.querySelectorAll('button.s');
for (var b = 0; b < scrolls.length; b++) scrolls[b].addEventListener('click', function (ev) {
  post('input', { kind: 'scroll', dx: 0, dy: Number(ev.currentTarget.getAttribute('data-dy')) });
});
['resumed', 'completed_manually', 'aborted'].forEach(function (d) {
  el(d).addEventListener('click', function () {
    if (d === 'aborted' && !window.confirm('Abort the run? The automation will not continue.')) return;
    post('resolve', { decision: d, note: el('note').value || '' });
  });
});

pullState().then(pullFrame);
setInterval(pullFrame, ${FRAME_MS});
setInterval(pullState, 1500);`;

  return shell('intervention ' + it.id, body, script);
}
