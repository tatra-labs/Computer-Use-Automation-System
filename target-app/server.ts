/**
 * MERIDIAN CORE — a stand-in for the back-office core-banking screens this
 * system exists to automate. Server-rendered, frameset shell, table layout,
 * randomized element ids, no test ids, native confirm() on the irreversible
 * action, and injectable runtime faults (the states a production replay must
 * survive). Two variants stand in for two tenants on one vendor product.
 */
import http from 'node:http';
import { URL } from 'node:url';
import { VARIANTS, Variant } from './variants.js';
import { MEMBERS, OPERATOR, AUTHORIZED_BRANCH, Member } from './data.js';
import { page, fieldRow, textInput, submitBtn, rid, rcls, esc } from './render.js';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, val] = a.replace(/^--/, '').split('=');
  return [k ?? '', val ?? 'true'] as const;
}));
const variant: Variant = VARIANTS[args.get('variant') ?? 'base'] ?? VARIANTS.base!;
const port = Number(args.get('port') ?? 8078);

type FaultMode = 'none' | 'slow' | 'interstitial' | 'session' | 'error500' | 'validation';
interface Fault { mode: FaultMode; once: boolean }
let fault: Fault = { mode: 'none', once: true };

const sessions = new Map<string, { user: string; created: number; seenNotice: boolean }>();
let subAcctSeq = 4400;

const cookie = (req: http.IncomingMessage): string | undefined =>
  /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];

function consumeFault(): FaultMode {
  const m = fault.mode;
  if (m !== 'none' && fault.once) fault = { mode: 'none', once: true };
  return m;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function send(res: http.ServerResponse, status: number, bodyHtml: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(bodyHtml);
}

const loginPage = (msg?: string) => page(variant, 'SIGN ON', `
${msg ? `<div class="err" id="${rid()}">${esc(msg)}</div><br>` : ''}
<form method="POST" action="/auth" id="${rid()}">
<table cellpadding="3" id="${rid()}">
${fieldRow('OPER ID', textInput('u', 16))}
${fieldRow('PASSWORD', `<input type="password" name="p" id="${rid()}" class="${rcls()}" size="16">`)}
<tr><td></td><td>${submitBtn('SIGN ON')}</td></tr>
</table></form>
<br><font size="1" color="#404040">AUTHORIZED USE ONLY &middot; SESSION IS LOGGED</font>`);

const homePage = () => page(variant, 'MAIN MENU', `
<b>FUNCTION MENU</b><br><br>
<table class="grid" cellpadding="4" id="${rid()}">
<tr><th>CD</th><th>FUNCTION</th></tr>
<tr><td>01</td><td><a href="${variant.routes.inquiry}" id="${rid()}">MEMBER INQUIRY</a></td></tr>
<tr><td>07</td><td><a href="${variant.routes.subacct}" id="${rid()}">SUB-ACCOUNT MAINTENANCE</a></td></tr>
</table>`);

const noticePage = (next: string) => page(variant, 'SYSTEM NOTICE', `
<div class="err" id="${rid()}">SYSTEM NOTICE 118 &mdash; SCHEDULED MAINTENANCE WINDOW SUN 02:00-04:00 CT.
ALL OPERATORS MUST ACKNOWLEDGE THIS NOTICE TO CONTINUE.</div><br>
<form method="GET" action="/ack" id="${rid()}">
<input type="hidden" name="next" value="${esc(next)}">
${submitBtn('ACKNOWLEDGE')}
</form>`);

const inquiryForm = (err?: string, prefill = '') => page(variant, 'MEMBER INQUIRY', `
${err ? `<div class="err" id="${rid()}">${esc(err)}</div><br>` : ''}
<form method="POST" action="${variant.routes.inquiry}" id="${rid()}">
<table cellpadding="3" id="${rid()}">
${fieldRow(variant.labels.memberNo, textInput('p1', 12, prefill))}
${fieldRow('SVC CD', `<select name="p2" id="${rid()}" class="${rcls()}"><option value="I">I - INQUIRY</option><option value="M">M - MAINT</option></select>`)}
<tr><td></td><td>${submitBtn(variant.labels.inquireBtn)}</td></tr>
</table></form>
<br><font size="1" color="#404040">F3=EXIT &nbsp; F7=BKWD &nbsp; F8=FRWD</font>`);

function memberDetail(m: Member): string {
  const rows = m.accounts.map((a) => {
    const label = a.kind === 'savings' ? variant.labels.savings : variant.labels.checking;
    return `<tr><td>${esc(a.code)}</td><td>${esc(label)}</td><td align="right">${esc(a.balance)}</td><td>${esc(a.opened)}</td></tr>`;
  }).join('');
  return page(variant, 'MEMBER DETAIL', `
<table cellpadding="2" id="${rid()}">
<tr><td align="right"><b>MBR:</b></td><td><font face="Courier New">${esc(m.no)}</font></td>
    <td align="right"><b>NAME:</b></td><td><font face="Courier New">${esc(m.name)}</font></td></tr>
<tr><td align="right"><b>SSN:</b></td><td><font face="Courier New">${esc(m.ssn)}</font></td>
    <td align="right"><b>BRANCH:</b></td><td><font face="Courier New">${esc(m.branch)}</font></td></tr>
<tr><td align="right"><b>STATUS:</b></td><td colspan="3"><font face="Courier New">${esc(m.status)}</font></td></tr>
</table><br>
<b>SHARE / DEPOSIT ACCOUNTS</b>
<table class="grid" cellpadding="4" id="${rid()}">
<tr><th>ACCT</th><th>TYPE</th><th>CURRENT BALANCE</th><th>OPENED</th></tr>
${rows}
</table><br>
<a href="${variant.routes.subacct}?mbr=${esc(m.no)}" id="${rid()}">${esc(variant.labels.subacctBtn)}</a>
&nbsp;|&nbsp; <a href="${variant.routes.inquiry}" id="${rid()}">NEW INQUIRY</a>`);
}

const CONFIRM_JS = 'return confirm(&quot;CONFIRM: POST NEW SUB-ACCOUNT? THIS ACTION IS IMMEDIATE.&quot;)';

const subacctForm = (mbr: string, err?: string) => page(variant, 'SUB-ACCOUNT OPEN', `
${err ? `<div class="err" id="${rid()}">${esc(err)}</div><br>` : ''}
<form method="POST" action="${variant.routes.subacct}" id="${rid()}" onsubmit="${CONFIRM_JS}">
<input type="hidden" name="mbr" value="${esc(mbr)}">
<table cellpadding="3" id="${rid()}">
${fieldRow(variant.labels.memberNo, `<font face="Courier New">${esc(mbr)}</font>`)}
${fieldRow('SUB TYPE', `<select name="t" id="${rid()}"><option value="SV2">SV2 - SECONDARY SAVINGS</option><option value="HOL">HOL - HOLIDAY CLUB</option></select>`)}
${fieldRow('NICKNAME', textInput('nk', 20))}
${fieldRow('INIT DEP', textInput('dep', 10))}
<tr><td></td><td>${submitBtn(variant.labels.subacctBtn, 'post')}</td></tr>
</table></form>`);

const confirmPage = (mbr: string, ref: string) => page(variant, 'SUB-ACCOUNT CONFIRMATION', `
<div style="border:2px solid #008000;padding:8px" id="${rid()}">
<b>POSTING COMPLETE</b><br><br>
<table cellpadding="2">
<tr><td align="right"><b>MBR NO:</b></td><td><font face="Courier New">${esc(mbr)}</font></td></tr>
<tr><td align="right"><b>REFERENCE NO:</b></td><td><font face="Courier New">${esc(ref)}</font></td></tr>
<tr><td align="right"><b>RESULT:</b></td><td><font face="Courier New">ACCEPTED</font></td></tr>
</table></div>`);

const errorPage = () => page(variant, 'APPLICATION ERROR', `
<div class="err" id="${rid()}">MCX-0500 UNHANDLED APPLICATION ERROR. CONTACT SYSTEM SUPPORT.
TRACE ID ${Math.random().toString(36).slice(2, 10).toUpperCase()}</div>`);

async function readBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const p = url.pathname;

  // ---- test-only control plane (never part of the automated surface) ----
  if (p === '/_fault' && req.method === 'POST') {
    const b = await readBody(req);
    fault = { mode: (b.get('mode') as FaultMode) ?? 'none', once: b.get('once') !== 'false' };
    return send(res, 200, JSON.stringify(fault), { 'content-type': 'application/json' });
  }
  if (p === '/_health') {
    return send(res, 200, JSON.stringify({ ok: true, variant: variant.key }), { 'content-type': 'application/json' });
  }

  // ---- frameset shell: a real multi-frame legacy layout ----
  if (p === '/') {
    return send(res, 200, `<html><head><title>${esc(variant.brand)}</title></head>
<frameset cols="176,*" border="1">
  <frame name="nav" src="/nav">
  <frame name="main" src="/main">
</frameset></html>`);
  }
  if (p === '/nav') {
    return send(res, 200, page(variant, 'NAV', `
<b>NAVIGATION</b><br><br>
<a href="/main" target="main" id="${rid()}">MAIN MENU</a><br><br>
<a href="${variant.routes.inquiry}" target="main" id="${rid()}">01 MEMBER INQUIRY</a><br><br>
<a href="${variant.routes.subacct}" target="main" id="${rid()}">07 SUB-ACCOUNT</a><br><br>
<a href="/signoff" target="main" id="${rid()}">99 SIGN OFF</a>`));
  }

  const sid = cookie(req);
  const sess = sid ? sessions.get(sid) : undefined;
  const f = consumeFault();

  if (f === 'error500') return send(res, 500, errorPage());
  if (f === 'slow') await sleep(Number(process.env.FAULT_SLOW_MS ?? 6500));
  if (f === 'session' && sid) sessions.delete(sid);

  if (p === '/signoff') {
    if (sid) sessions.delete(sid);
    return send(res, 200, loginPage('SESSION ENDED. SIGN ON TO CONTINUE.'));
  }

  if (p === '/auth' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.get('u') === OPERATOR.user && b.get('p') === OPERATOR.password) {
      const ns = Math.random().toString(36).slice(2);
      sessions.set(ns, { user: OPERATOR.user, created: Date.now(), seenNotice: false });
      const next = variant.forceNoticeAfterLogin ? noticePage('/main') : homePage();
      return send(res, 200, next, { 'set-cookie': `sid=${ns}; Path=/; HttpOnly` });
    }
    return send(res, 200, loginPage('SEC-0001 INVALID OPER ID OR PASSWORD.'));
  }

  if (p === '/ack') {
    if (sess) sess.seenNotice = true;
    return send(res, 302, '', { location: url.searchParams.get('next') ?? '/main' });
  }

  // ---- everything below requires a session ----
  if (!sess) return send(res, 200, loginPage(sid ? 'SEC-0900 SESSION EXPIRED OR TIMED OUT. SIGN ON AGAIN.' : undefined));

  if (f === 'interstitial') return send(res, 200, noticePage(p + (url.search || '')));
  if (p === '/main') return send(res, 200, homePage());

  if (p === variant.routes.inquiry) {
    if (req.method === 'GET') return send(res, 200, inquiryForm());
    const b = await readBody(req);
    const no = (b.get('p1') ?? '').trim();
    if (!/^\d{5}$/.test(no)) return send(res, 200, inquiryForm('ERR-1001 MBR NO MUST BE 5 NUMERIC DIGITS.', no));
    const m = MEMBERS[no];
    if (!m) return send(res, 200, inquiryForm(`ERR-1404 RECORD NOT FOUND FOR MBR NO ${no}.`, no));
    if (m.branch !== AUTHORIZED_BRANCH) {
      return send(res, 200, inquiryForm(`SEC-4021 NOT AUTHORIZED FOR BRANCH ${m.branch}. CONTACT SECURITY ADMIN.`, no));
    }
    return send(res, 200, memberDetail(m));
  }

  if (p === variant.routes.subacct) {
    if (req.method === 'GET') {
      const mbr = (url.searchParams.get('mbr') ?? '').trim();
      if (!MEMBERS[mbr]) return send(res, 200, inquiryForm('ERR-1404 SELECT A MEMBER BEFORE SUB-ACCOUNT MAINTENANCE.'));
      return send(res, 200, subacctForm(mbr));
    }
    const b = await readBody(req);
    const mbr = (b.get('mbr') ?? '').trim();
    const m = MEMBERS[mbr];
    if (!m) return send(res, 200, inquiryForm(`ERR-1404 RECORD NOT FOUND FOR MBR NO ${mbr}.`));
    if (f === 'validation' || !(b.get('nk') ?? '').trim()) {
      return send(res, 200, subacctForm(mbr, 'ERR-2001 NICKNAME IS REQUIRED.'));
    }
    if (m.subacctBlocked) return send(res, 200, subacctForm(mbr, m.subacctBlocked));
    return send(res, 200, confirmPage(mbr, `SA-${++subAcctSeq}`));
  }

  return send(res, 404, page(variant, 'NOT FOUND', `<div class="err">MCX-0404 FUNCTION NOT DEFINED: ${esc(p)}</div>`));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[target-app] ${variant.brand} — variant=${variant.key} → http://127.0.0.1:${port}/`);
});
