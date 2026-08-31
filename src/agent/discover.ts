/**
 * Discovery: the one place a model is in the loop.
 *
 * observe → decide → act, against the live surface, until the goal is reached or
 * a stopping condition fires. Two constraints shape it:
 *
 *  - The model may only refer to controls the way an artifact can address them
 *    (role + caption + refs), so anything it achieves is recordable.
 *  - Authentication and known application states are handled deterministically
 *    from the app profile *before* the model is consulted. The model never sees a
 *    credential and never has to reason about a maintenance banner.
 *
 * Every action taken is recorded together with the *verified* descriptor that
 * found it, which is what the compiler turns into a capability.
 */
import type { AppProfile, CapabilityOutput, Risk } from '../core/artifact.js';
import { evaluate, interpolate, ParamValues } from '../core/predicate.js';
import { resolveTarget } from '../core/resolve.js';
import type { Control, Observation, TargetDescriptor } from '../core/target.js';
import type { Escalator } from '../escalation/escalator.js';
import { extractOutput } from '../replay/extract.js';
import { classify, mergeRules } from '../replay/monitors.js';
import { runSubflow } from '../replay/step-runner.js';
import type { Session } from '../session/session.js';
import { Planner, PlannedDecision, PlannerError } from './planner.js';
import { HistoryEntry, PROMPT_VERSION, ParamSpec, renderObservation, systemPrompt, userTurn } from './prompt.js';
import { synthesizeDescriptor } from './synthesize.js';

export interface DiscoverParam extends ParamSpec { value: string }

export interface DiscoverRequest {
  goal: string;
  entry: string;
  productTitle: string;
  profile?: AppProfile;
  params: DiscoverParam[];
  maxSteps: number;
}

export interface OutputProposal {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'money' | 'date';
  description: string;
  sensitivity: 'public' | 'internal' | 'pii' | 'secret';
  descriptor?: TargetDescriptor;
  regex?: string;
  rationale?: string;
  /**
   * Extraction is executed at record time, so a declared output that cannot
   * actually be read is caught here rather than on the first production call.
   * The sampled value is also what lets the compiler recognise (and refuse) a
   * checkpoint pattern that has a data value baked into it.
   */
  verified: boolean;
  sampleValue?: string;
}

export interface RecordedAction {
  seq: number;
  intent: string;
  risk: Risk;
  kind: 'click' | 'type' | 'select' | 'press' | 'navigate' | 'dialog';
  descriptor?: TargetDescriptor;
  matchScore?: number;
  text?: { kind: 'param'; param: string } | { kind: 'literal'; value: string };
  locus?: string;
  key?: string;
  value?: string;
  decision?: 'accept' | 'dismiss';
  pressEnter?: boolean;
  expectAfter?: string;
  before: StateSnapshot;
  after: StateSnapshot;
  humanAssisted?: boolean;
}

/**
 * Enough of the screen, before and after, for the compiler to tell whether a
 * candidate checkpoint actually *discriminates* — a condition that already held
 * before the action cannot prove the action worked.
 */
export interface StateSnapshot {
  locus: string;
  title: string;
  fingerprint: string;
  text: string;
  /** role + caption signatures of everything visible, US-separated. */
  keys: string[];
  /** A native modal (e.g. a confirm() on an irreversible submit) is pending. */
  dialog: boolean;
}

export interface DiscoverOutcome {
  status: 'success' | 'stuck' | 'failed';
  reason?: string;
  recorded: RecordedAction[];
  outputs: OutputProposal[];
  successText?: string;
  entryFingerprint: string;
  entryText: string;
  /**
   * role+caption signatures visible on the settled home screen, before any
   * goal-directed action. A frameset's nav frame (MAIN MENU, MEMBER INQUIRY, …)
   * is present here and on every screen thereafter, which is what lets the
   * compiler tell permanent chrome apart from content that actually changed.
   */
  chromeKeys: string[];
  llmCalls: number;
  /** Steps a human performed. Their presence keeps the artifact in draft. */
  humanAssisted: string[];
  finalObservation?: Observation;
}

export interface DiscoverDeps {
  session: Session;
  planner: Planner;
  escalator?: Escalator;
}

const MAX_PLANNER_RETRIES = 1;

export async function discover(req: DiscoverRequest, deps: DiscoverDeps): Promise<DiscoverOutcome> {
  const { session, planner } = deps;
  const params: ParamValues = Object.fromEntries(req.params.map((p) => [p.name, p.value]));
  for (const p of req.params) {
    if (p.sensitivity === 'pii' || p.sensitivity === 'secret') session.redactor.registerValue(p.value, p.sensitivity);
  }

  const rules = mergeRules({ faults: [], recovery: [], outcomes: [] }, req.profile);
  const recorded: RecordedAction[] = [];
  const history: HistoryEntry[] = [];
  const humanAssisted: string[] = [];
  const outputs: OutputProposal[] = [];
  let llmCalls = 0;
  let successText: string | undefined;

  const system = systemPrompt({ jsonOnly: planner.id !== 'anthropic-api', productTitle: req.productTitle });

  const nav = await session.act({ kind: 'navigate', risk: 'read', locus: req.entry, describe: `open ${req.entry}` });
  if (!nav.ok) {
    return finish('failed', `could not open entry point: ${nav.reason}`);
  }
  const entryObs = await session.observe('entry');
  const entryFingerprint = entryObs.fingerprint;
  const entryText = entryObs.text;

  /**
   * Clear anything the profile already knows how to clear (sign-on, notices)
   * before asking a model to reason about the screen.
   */
  async function settleKnownStates(): Promise<Observation> {
    let obs = await session.observe('settle');
    for (let i = 0; i < 4; i++) {
      const cls = classify(obs, rules, { params, completed: new Set() });
      if (cls.kind !== 'recovery') break;
      session.journal.event('recovery.start', { code: cls.rule.code, detail: cls.detail, phase: 'discovery' });
      const r = await runSubflow(session, cls.rule.actions, params);
      session.journal.event('recovery.end', { code: cls.rule.code, ok: r.ok, reason: r.ok ? undefined : r.reason });
      if (!r.ok) break;
      obs = await session.observe('after-settle');
    }
    return obs;
  }

  let obs = await settleKnownStates();
  let finalObs = obs;
  const chromeKeys = snap(obs).keys;

  for (let turn = 1; turn <= req.maxSteps; turn++) {
    const budget = session.gate.countLlmCall();
    if (!budget.allow) return finish('failed', budget.reason);
    if (session.gate.expired()) return finish('failed', 'discovery duration budget exhausted');

    obs = await settleKnownStates();
    finalObs = obs;

    const rendered = renderObservation(obs, session.redactor);
    const user = userTurn({
      goal: req.goal, params: req.params, history, observation: rendered,
      stepsLeft: req.maxSteps - turn + 1,
    });

    let decision: PlannedDecision;
    try {
      decision = await callPlanner(user);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      session.journal.event('llm.error', { turn, error: msg });
      return finish('failed', `planner failed: ${msg}`);
    }
    llmCalls++;

    await session.journal.saveScreenshot(session.surface, `turn-${turn}-${decision.tool}`);

    if (decision.tool === 'done') {
      successText = decision.successText;
      for (const o of decision.outputs ?? []) {
        outputs.push(buildOutput(o, obs, session));
      }
      session.journal.event('note', { turn, note: 'planner reported goal reached', successText, outputs: outputs.map((o) => o.name) });
      finalObs = obs;
      return finish('success');
    }

    if (decision.tool === 'stuck') {
      const reason = decision.reason ?? decision.thought;
      const resumed = await escalateStuck(reason, obs);
      if (!resumed) return finish('stuck', reason);
      humanAssisted.push(`turn-${turn}`);
      recorded.push({
        seq: recorded.length + 1, intent: `[human] ${reason}`, risk: 'write', kind: 'press', key: '(manual)',
        before: snap(obs), after: snap(await session.observe('after-human')), humanAssisted: true,
      });
      history.push({ n: turn, tool: 'human', intent: reason, result: 'a human operator intervened on the live session' });
      continue;
    }

    const exec = await executeDecision(decision, obs, turn);
    history.push({ n: turn, tool: decision.tool, intent: decision.thought, result: exec.result });
    if (exec.recorded) recorded.push(exec.recorded);
    if (exec.fatal) return finish('failed', exec.result);
  }

  return finish('failed', `goal not reached within ${req.maxSteps} planner turns`);

  // -- helpers ---------------------------------------------------------------

  async function callPlanner(user: string): Promise<PlannedDecision> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_PLANNER_RETRIES; attempt++) {
      session.journal.event('llm.request', { provider: planner.id, model: planner.model, promptVersion: PROMPT_VERSION, userChars: user.length });
      try {
        const out = await planner.decide({ system, user });
        session.journal.event('llm.response', { provider: planner.id, model: out.model, tool: out.decision.tool, thought: out.decision.thought, usage: out.usage });
        session.journal.appendJsonl('transcript.jsonl', {
          at: new Date().toISOString(), provider: planner.id, model: out.model,
          system, user, response: out.raw, usage: out.usage,
        });
        return out.decision;
      } catch (e) {
        lastErr = e;
        session.journal.event('llm.error', {
          attempt, error: e instanceof Error ? e.message : String(e),
          raw: e instanceof PlannerError ? e.raw : undefined,
        });
      }
    }
    throw lastErr;
  }

  async function executeDecision(
    d: PlannedDecision, before: Observation, turn: number,
  ): Promise<{ result: string; recorded?: RecordedAction; fatal?: boolean }> {
    const risk: Risk = d.risk ?? (d.tool === 'click' || d.tool === 'navigate' ? 'read' : 'write');

    if (d.tool === 'navigate') {
      if (!d.locus) return { result: 'refused: navigate without a locus' };
      const out = await session.act({ kind: 'navigate', risk, describe: d.thought, locus: d.locus, confirmed: false });
      if (!out.ok) return { result: `refused: ${out.code} — ${out.reason}` };
      const after = await session.observe(`after-turn-${turn}`);
      return {
        result: describeAfter(after, d.expectAfter),
        recorded: { seq: recorded.length + 1, intent: d.thought, risk, kind: 'navigate', locus: d.locus, expectAfter: d.expectAfter, before: snap(before), after: snap(after) },
      };
    }

    if (d.tool === 'press') {
      const out = await session.act({ kind: 'press', risk, describe: d.thought, key: d.key ?? 'Enter', confirmed: false });
      if (!out.ok) return { result: `refused: ${out.code} — ${out.reason}` };
      const after = await session.observe(`after-turn-${turn}`);
      return {
        result: describeAfter(after, d.expectAfter),
        recorded: { seq: recorded.length + 1, intent: d.thought, risk, kind: 'press', key: d.key ?? 'Enter', expectAfter: d.expectAfter, before: snap(before), after: snap(after) },
      };
    }

    if (d.tool === 'answer_dialog') {
      if (!before.pendingDialog) return { result: 'refused: no dialog is pending' };
      // Answering a confirm on a legacy banking screen commits the underlying
      // action, so it inherits the risk of what it confirms.
      const dialogRisk: Risk = d.decision === 'accept' ? (d.risk ?? 'irreversible') : 'read';
      const out = await actWithApproval({ kind: 'dialog', risk: dialogRisk, describe: d.thought, decision: d.decision ?? 'dismiss' }, before, `turn-${turn}`);
      if (!out.ok) return { result: `refused: ${out.code} — ${out.reason}`, fatal: out.code === 'CONTROL_LOST' };
      const after = await session.observe(`after-turn-${turn}`);
      if (out.humanApproved) humanAssisted.push(`turn-${turn}`);
      return {
        result: describeAfter(after, d.expectAfter),
        recorded: { seq: recorded.length + 1, intent: d.thought, risk: dialogRisk, kind: 'dialog', decision: d.decision ?? 'dismiss', expectAfter: d.expectAfter, before: snap(before), after: snap(after) },
      };
    }

    // Remaining tools act on a control.
    if (!d.ref) return { result: `refused: ${d.tool} without a ref` };
    const control = before.controls.find((c) => c.ref === d.ref);
    if (!control) return { result: `refused: ref "${d.ref}" is not in the observation you were shown` };

    const syn = synthesizeDescriptor(control, before);
    session.journal.event('resolve', { turn, ref: control.ref, descriptor: syn.descriptor, rationale: syn.rationale, score: syn.score });

    let text: string | undefined;
    let textSource: RecordedAction['text'];
    if (d.tool === 'type') {
      const raw = d.text ?? '';
      const paramMatch = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(raw.trim());
      if (paramMatch) {
        const p = paramMatch[1]!;
        if (!(p in params)) return { result: `refused: unknown parameter {{${p}}}` };
        textSource = { kind: 'param', param: p };
        text = String(params[p]);
      } else {
        const asParam = req.params.find((p) => p.value === raw.trim());
        if (asParam) {
          // The model typed the concrete value; record it as the parameter anyway.
          textSource = { kind: 'param', param: asParam.name };
          text = asParam.value;
          session.journal.event('note', { turn, note: `literal value re-bound to parameter "${asParam.name}"` });
        } else if (session.redactor.wouldRedact(raw)) {
          // Guardrail: a value that looks like regulated data and is not a
          // declared parameter must not be typed or recorded.
          session.journal.event('policy.deny', { turn, reason: 'planner attempted to type data matching a sensitive pattern', kind: 'type' });
          return { result: 'refused by policy: that value looks like regulated data and is not a declared parameter. Use a {{parameter}}.' };
        } else {
          textSource = { kind: 'literal', value: raw };
          text = interpolate(raw, params);
        }
      }
    }

    const out = await actWithApproval({
      kind: d.tool === 'type' ? 'type' : d.tool === 'select' ? 'select' : 'click',
      risk, describe: d.thought, ref: control.ref, text,
      value: d.value, pressEnter: d.pressEnter ?? false, clearFirst: true,
    }, before, `turn-${turn}`);

    if (!out.ok) return { result: `refused: ${out.code} — ${out.reason}`, fatal: out.code === 'CONTROL_LOST' };
    if (out.humanApproved) humanAssisted.push(`turn-${turn}`);

    const after = await session.observe(`after-turn-${turn}`);
    return {
      result: describeAfter(after, d.expectAfter),
      recorded: {
        seq: recorded.length + 1, intent: d.thought, risk,
        kind: d.tool === 'type' ? 'type' : d.tool === 'select' ? 'select' : 'click',
        descriptor: syn.descriptor, matchScore: syn.score,
        text: textSource, value: d.value, pressEnter: d.pressEnter ?? false,
        expectAfter: d.expectAfter, before: snap(before), after: snap(after),
      },
    };
  }

  /**
   * Risky actions during discovery are not blocked outright — they are routed to
   * a human, who sees the actual screen and decides. That is the difference
   * between a guardrail and an obstacle.
   */
  async function actWithApproval(
    req2: Parameters<Session['act']>[0], obs2: Observation, label: string,
  ): Promise<{ ok: boolean; code?: string; reason?: string; humanApproved?: boolean }> {
    const first = await session.act({ ...req2, confirmed: false });
    if (first.ok) return { ok: true };
    if (first.code !== 'CONFIRMATION_REQUIRED') return { ok: false, code: first.code, reason: first.reason };

    if (!deps.escalator) {
      return { ok: false, code: 'CONFIRMATION_REQUIRED', reason: `${first.reason}; no operator attached during discovery` };
    }
    const int = await deps.escalator.raise(session, {
      mode: 'discovery', reason: 'CONFIRMATION_REQUIRED',
      summary: `A ${req2.risk} action needs approval: ${req2.describe}`,
      askedFor: [`Approve this ${req2.risk} action`, 'Or abort the discovery run'],
      observation: obs2, goal: req.goal,
    });
    const resolved = await deps.escalator.waitForResolution(session, int.id);
    const decision = resolved.resolution?.decision;
    if (decision !== 'resumed' && decision !== 'completed_manually') {
      return { ok: false, code: 'CONFIRMATION_REQUIRED', reason: `operator ${decision ?? 'did not respond'} at ${label}` };
    }
    const second = await session.act({ ...req2, humanApproved: true });
    return second.ok ? { ok: true, humanApproved: true } : { ok: false, code: second.code, reason: second.reason };
  }

  async function escalateStuck(reason: string, obs2: Observation): Promise<boolean> {
    if (!deps.escalator) return false;
    const int = await deps.escalator.raise(session, {
      mode: 'discovery', reason: 'AGENT_STUCK', summary: reason, goal: req.goal, observation: obs2,
      askedFor: [
        'Take control of the live session and perform the step the automation could not',
        'Then hand control back so discovery can continue from the resulting screen',
        'Or abort the run',
      ],
    });
    const resolved = await deps.escalator.waitForResolution(session, int.id);
    const d = resolved.resolution?.decision;
    return d === 'resumed' || d === 'completed_manually';
  }

  function describeAfter(after: Observation, expectAfter?: string): string {
    const bits = [`now at ${after.locus} "${session.redactor.text(after.title)}"`];
    if (expectAfter) {
      const held = evaluate({ kind: 'textMatches', pattern: escapeRe(expectAfter) }, after, params).ok;
      bits.push(held ? `expected text "${expectAfter}" IS present` : `expected text "${expectAfter}" is NOT present`);
    }
    const alert = after.controls.find((c) => /^(ERR|SEC|MCX|SYSTEM NOTICE)/i.test(c.name));
    if (alert) bits.push(`screen message: "${session.redactor.text(alert.name)}"`);
    if (after.pendingDialog) bits.push(`a ${after.pendingDialog.kind} dialog is now blocking the page`);
    return bits.join('; ');
  }

  function finish(status: DiscoverOutcome['status'], reason?: string): DiscoverOutcome {
    return { status, reason, recorded, outputs, successText, entryFingerprint, entryText, chromeKeys, llmCalls, humanAssisted, finalObservation: finalObs };
  }
}

const snap = (o: Observation): StateSnapshot => ({
  locus: o.locus,
  title: o.title,
  fingerprint: o.fingerprint,
  text: o.text.slice(0, 6000),
  // Legacy title bars contain '|', so the separator has to be something a
  // caption cannot hold.
  keys: o.controls.map((c) => `${c.role}\u001f${(c.name || c.labels[0] || '').toUpperCase()}`),
  dialog: !!o.pendingDialog,
});

function buildOutput(
  o: NonNullable<PlannedDecision['outputs']>[number], obs: Observation, session: Session,
): OutputProposal {
  const base = { name: toSnake(o.name), type: o.type, description: o.description, sensitivity: o.sensitivity };
  let proposal: OutputProposal;

  const control = o.ref ? obs.controls.find((c) => c.ref === o.ref) : undefined;
  if (control) {
    const syn = synthesizeDescriptor(control, obs);
    proposal = { ...base, descriptor: syn.descriptor, rationale: syn.rationale, verified: false };
  } else if (o.regex) {
    proposal = { ...base, regex: o.regex, rationale: 'page-text regex proposed by the planner', verified: false };
  } else {
    // Emit something reviewable rather than silently dropping a declared output.
    proposal = {
      ...base,
      regex: `${escapeRe(o.name)}\\s*[:#]?\\s*([^\\n]+)`,
      rationale: 'fallback: derived from the output name',
      verified: false,
    };
  }

  // Extraction is exercised at record time: an output that cannot be read is a
  // defect in the recording, not a surprise for the first production caller.
  const probe = extractOutput(obs, toOutputSpec(proposal), {});
  if (probe.ok) {
    proposal.verified = true;
    proposal.sampleValue = probe.raw;
  } else {
    proposal.rationale = `${proposal.rationale}; NOT VERIFIED at record time: ${probe.reason}`;
  }
  session.journal.event('extract', {
    name: proposal.name, verified: proposal.verified,
    value: proposal.sampleValue, rationale: proposal.rationale,
  });
  return proposal;
}

/** The minimal CapabilityOutput needed to exercise extraction at record time. */
function toOutputSpec(p: OutputProposal): CapabilityOutput {
  return {
    name: p.name, type: p.type, description: p.description, sensitivity: p.sensitivity, required: true,
    transform: ['trim', 'collapseSpace'],
    source: p.descriptor
      ? (['textbox', 'password', 'combobox'].includes(p.descriptor.role)
          ? { kind: 'controlValue', target: p.descriptor }
          : { kind: 'controlText', target: p.descriptor })
      : { kind: 'pageRegex', pattern: p.regex ?? '(?!)', group: 1 },
  };
}

const toSnake = (s: string): string =>
  s.trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export { escapeRe, toSnake };
