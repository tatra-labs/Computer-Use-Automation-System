/**
 * What the model sees.
 *
 * The observation is rendered as roles + captions + refs — the same semantic view
 * the replay engine resolves against. That is deliberate: if the model can only
 * refer to controls the way an artifact can address them, then anything it
 * achieves is expressible as a replayable step. A screenshot-and-coordinates
 * prompt would let the model succeed in ways the artifact cannot reproduce.
 */
import type { Observation } from '../core/target.js';
import type { Redactor } from '../policy/redact.js';

export const PROMPT_VERSION = 'discovery/v1';

export interface ParamSpec {
  name: string;
  type: string;
  description: string;
  sensitivity: string;
}

export function systemPrompt(opts: { jsonOnly: boolean; productTitle: string }): string {
  return [
    `You are the discovery planner for an automation system that drives back-office`,
    `applications at US banks and credit unions. You are operating "${opts.productTitle}",`,
    `a legacy web application with no API. You act the way a trained human operator would:`,
    `read the screen, then click or type.`,
    ``,
    `You are shown a SEMANTIC OBSERVATION of the current screen, not HTML. Each control has`,
    `a ref like f1c7, a role, an accessible name in quotes, and inferred captions in`,
    `labels=... (legacy screens put the caption in the table cell to the left of the field,`,
    `so labels are usually how a field is identified). Refer to controls ONLY by ref.`,
    `Refs change on every observation — always use refs from the observation you were just shown.`,
    ``,
    `Choose exactly ONE action per turn:`,
    `  click        {ref}                     press a button or follow a link`,
    `  type         {ref, text, pressEnter?}  enter text into a field`,
    `  select       {ref, value}              choose an option in a dropdown`,
    `  press        {key}                     a bare keystroke, e.g. Enter or Tab`,
    `  navigate     {locus}                   go to a URL (only within the allowed application)`,
    `  answer_dialog{decision}                accept or dismiss a native modal that is blocking the page`,
    `  done         {successText, outputs}    the goal is reached`,
    `  stuck        {reason}                  you cannot proceed safely — a human will be paged`,
    ``,
    `Rules that matter:`,
    `- PARAMETERS: when a value is supplied as a parameter, type the literal token`,
    `  {{paramName}} — never the concrete value. The harness substitutes it, and this is`,
    `  what makes the recording reusable for other members.`,
    `- CREDENTIALS: you will never be asked to sign on. If you see a sign-on screen,`,
    `  something is wrong: use "stuck". Never invent or type a username or password.`,
    `- RISK: label every action. "read" observes or navigates. "write" changes data but is`,
    `  correctable. "irreversible" posts a transaction, opens or closes an account, or moves`,
    `  money. Be conservative: if a screen warns that an action is immediate or final, it is`,
    `  irreversible. Irreversible actions may be paused for human approval; that is expected.`,
    `- expectAfter: on every action, quote a SHORT piece of LITERAL TEXT that will be on the`,
    `  screen after the action and is NOT on it now — a heading, a column header, a field`,
    `  caption, an error code. Two rules: copy it exactly as it appears (it is matched`,
    `  against the screen, so a description in your own words is useless), and never use a`,
    `  DATA VALUE such as a balance, a name or a date, because those differ on every run and`,
    `  would pin the recording to one record. "CURRENT BALANCE" is right; "the detail screen`,
    `  shows 4,812.63 for Dana" is wrong on both counts.`,
    `- Do not repeat an action that just failed to change the screen; try a different route`,
    `  or use "stuck".`,
    `- successText on "done" follows the same two rules: short, literal, on-screen, and free`,
    `  of data values.`,
    `- On "done", declare the outputs the capability should return: name them in snake_case,`,
    `  point each at the control ref holding the value (or give a regex over the page text`,
    `  with one capture group), classify sensitivity (a member's balance is "internal"; a`,
    `  name, SSN or address is "pii"), and write a one-sentence "description" for each —`,
    `  it is what a human reviewer and a calling agent will read to know what the value`,
    `  means, so never leave it blank.`,
    ``,
    opts.jsonOnly
      ? [
          `OUTPUT FORMAT: reply with a single JSON object and nothing else. No prose, no`,
          `markdown fence, no explanation before or after. Shape:`,
          `{"thought":"...","tool":"click","ref":"f1c7","risk":"read","expectAfter":"..."}`,
        ].join('\n')
      : `Call the "decide" tool exactly once.`,
  ].join('\n');
}

export function renderObservation(obs: Observation, redactor: Redactor, limit = 90): string {
  const r = (s: string) => redactor.text(s);
  const lines: string[] = [
    `LOCUS: ${obs.locus}`,
    `TITLE: ${r(obs.title)}`,
    `FRAMES: ${obs.frames.map((f) => f.name).join(', ') || '(none)'}`,
  ];
  if (obs.pendingDialog) {
    lines.push(`!! A NATIVE ${obs.pendingDialog.kind.toUpperCase()} DIALOG IS BLOCKING THE PAGE: "${r(obs.pendingDialog.message)}"`);
    lines.push(`!! You must answer it with answer_dialog before anything else can happen.`);
  }

  lines.push('', 'CONTROLS:');
  const shown = obs.controls.slice(0, limit);
  for (const c of shown) {
    const bits = [`[${c.ref}]`, c.role.padEnd(12)];
    if (c.name) bits.push(`"${r(c.name)}"`);
    if (c.labels.length) bits.push(`labels="${c.labels.map(r).join(' | ')}"`);
    if (c.value) bits.push(`value="${r(c.value)}"`);
    if (c.frame.length) bits.push(`frame=${c.frame.join('/')}`);
    if (!c.enabled) bits.push('(disabled)');
    lines.push('  ' + bits.join(' '));
  }
  if (obs.controls.length > shown.length) {
    lines.push(`  … ${obs.controls.length - shown.length} more controls not shown`);
  }

  lines.push('', 'VISIBLE TEXT:', r(obs.text).slice(0, 2500));
  return lines.join('\n');
}

export interface HistoryEntry {
  n: number;
  tool: string;
  intent: string;
  result: string;
}

export function userTurn(opts: {
  goal: string;
  params: ParamSpec[];
  history: HistoryEntry[];
  observation: string;
  stepsLeft: number;
}): string {
  const params = opts.params.length === 0
    ? '  (none)'
    : opts.params.map((p) => `  {{${p.name}}}  ${p.type}  — ${p.description} [${p.sensitivity}]`).join('\n');

  const history = opts.history.length === 0
    ? '  (nothing yet — this is the first action)'
    : opts.history.slice(-10).map((h) => `  #${h.n} ${h.tool}: ${h.intent}\n      → ${h.result}`).join('\n');

  return [
    `GOAL: ${opts.goal}`,
    ``,
    `PARAMETERS AVAILABLE (type the {{token}}, never the value):`,
    params,
    ``,
    `WHAT YOU HAVE DONE SO FAR:`,
    history,
    ``,
    `ACTIONS REMAINING BEFORE THE RUN IS STOPPED: ${opts.stepsLeft}`,
    ``,
    `CURRENT SCREEN`,
    `==============`,
    opts.observation,
    ``,
    `Choose the single next action.`,
  ].join('\n');
}
