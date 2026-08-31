/**
 * Deterministic replay: the path an AI agent triggers in production.
 *
 * No model is consulted. Every decision comes from the artifact: which control
 * (TargetDescriptor + scored resolution), when to proceed (checkpoint
 * predicates, polled — never slept), what a screen means (the three ordered rule
 * lists), and what to return (declared outputs).
 *
 * Determinism comes from four properties:
 *  1. resolution is a pure, totally-ordered function of the observation, and a
 *     near-tie is an explicit AMBIGUOUS_TARGET rather than a coin flip;
 *  2. progress is gated on asserted post-conditions, so a slow screen waits and
 *     a wrong screen fails — neither becomes a race;
 *  3. retries and recoveries are bounded and counted per rule code, so a
 *     recurring condition terminates instead of looping;
 *  4. nothing outside the artifact (clock, randomness, model) influences control
 *     flow.
 */
import type { AppProfile, Capability, Step } from '../core/artifact.js';
import { validateInputs } from '../core/load.js';
import { describePredicate, evaluate, interpolate, interpolateTarget, ParamValues } from '../core/predicate.js';
import { describeTarget, resolveTarget } from '../core/resolve.js';
import type { FailureCode, OutputValues, RecoveryRecord, ReplayResult, StepRecord } from '../core/result.js';
import type { Control, Observation, TargetDescriptor } from '../core/target.js';
import type { Escalator } from '../escalation/escalator.js';
import type { InterventionReason } from '../escalation/intervention.js';
import type { ActOutcome, Session } from '../session/session.js';
import { extractOutput } from './extract.js';
import { classify, Classification, mergeRules, RecoveryLedger, RuleSet } from './monitors.js';

export interface ReplayRequest {
  capability: Capability;
  profile?: AppProfile;
  tenant: string | null;
  inputs: Record<string, unknown>;
  /** No human is watching: gate on approval + stability. */
  unattended: boolean;
  /** The caller explicitly authorized risky/irreversible steps. */
  confirmed: boolean;
}

export interface ReplayDeps {
  session: Session;
  escalator?: Escalator;
}

type StepVerdict =
  | { kind: 'ok'; record: StepRecord }
  | { kind: 'skipped'; record: StepRecord }
  | { kind: 'terminal'; result: ReplayResult }
  | { kind: 'problem'; code: FailureCode; message: string; expected?: string; observed?: string; record: StepRecord };

const POLL_MS = 200;

export async function replay(req: ReplayRequest, deps: ReplayDeps): Promise<ReplayResult> {
  return new ReplayEngine(req, deps).run();
}

class ReplayEngine {
  private readonly cap: Capability;
  private readonly session: Session;
  private readonly rules: RuleSet;
  private readonly ledger = new RecoveryLedger();
  private readonly startedAt = new Date().toISOString();
  private readonly t0 = Date.now();

  private params: ParamValues = {};
  private outputs: OutputValues = {};
  private records: StepRecord[] = [];
  private recoveries: RecoveryRecord[] = [];
  private completed = new Set<string>();
  private humanApproved = new Set<string>();
  private extracted = new Set<string>();
  /**
   * Recovery sub-flows must not be re-classified: the screen that triggered the
   * rule is still on display while we clear it, which would recurse forever.
   */
  private inRecovery = false;
  private drift: ReplayResult['drift'];
  private escalation: ReplayResult['escalation'];
  private failureSnapshot: string | undefined;
  private lastObs: Observation | undefined;

  constructor(private req: ReplayRequest, private deps: ReplayDeps) {
    this.cap = req.capability;
    this.session = deps.session;
    this.rules = mergeRules(this.cap, req.profile);
  }

  // -- lifecycle -------------------------------------------------------------

  async run(): Promise<ReplayResult> {
    const validated = validateInputs(this.cap, this.req.inputs);
    if (!validated.ok) {
      return this.fail('INPUT_INVALID', validated.errors.join('; '));
    }
    this.params = validated.values;
    this.registerSensitiveInputs();

    const inv = this.session.gate.checkInvocation(this.cap, {
      unattended: this.req.unattended,
      confirmed: this.req.confirmed,
    });
    if (!inv.allow) {
      const code: FailureCode = /approval|approved/i.test(inv.reason) ? 'APPROVAL_REQUIRED' : 'POLICY_DENIED';
      return this.fail(code, inv.reason);
    }
    // Confirmation is resolved at the exact step that needs it, where a human can
    // see the real screen — but only if there is anyone to ask.
    if (inv.requiresConfirmation && !this.deps.escalator) {
      return this.fail('CONFIRMATION_REQUIRED', `${inv.reason}; pass --confirm or attach an operator`);
    }

    const entry = interpolate(this.cap.app.entry, this.params);
    const nav = await this.session.act({
      kind: 'navigate', risk: 'read', locus: entry, describe: `open entry point ${entry}`,
    });
    if (!nav.ok) return this.failFromAct(nav);

    const obs = await this.observe('entry');
    this.checkDrift(obs);

    for (let i = 0; i < this.cap.steps.length; i++) {
      const step = this.cap.steps[i]!;
      const budget = this.session.gate.countStep();
      if (!budget.allow) return this.fail('POLICY_DENIED', budget.reason, step.id);
      if (this.session.gate.expired()) return this.fail('TIMEOUT', 'capability duration budget exhausted', step.id);

      const verdict = await this.runStepWithRetries(step);
      if (verdict.kind === 'terminal') return verdict.result;
      this.records.push(verdict.record);
      if (verdict.kind === 'problem') {
        return this.problemToResult(step, verdict);
      }
      this.completed.add(step.id);
    }

    return this.finishSuccessfully();
  }

  private registerSensitiveInputs(): void {
    for (const spec of this.cap.contract.inputs) {
      if (spec.sensitivity === 'pii' || spec.sensitivity === 'secret') {
        this.session.redactor.registerValue(String(this.params[spec.name] ?? ''), spec.sensitivity);
      }
    }
  }

  private checkDrift(obs: Observation): void {
    const expected = this.cap.provenance.entryFingerprint;
    const changed = !!expected && expected !== obs.fingerprint;
    this.drift = { expected, observed: obs.fingerprint, changed };
    if (changed) {
      // A warning, never a gate: the whole point of semantic locators is that a
      // reshaped screen can still be driven.
      this.session.journal.event('drift', {
        expected, observed: obs.fingerprint,
        note: 'entry screen shape differs from the recording; proceeding on semantic locators',
      });
    }
  }

  // -- step execution --------------------------------------------------------

  private async runStepWithRetries(step: Step): Promise<StepVerdict> {
    const maxAttempts = step.retries + 1;
    let last: StepVerdict | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const verdict = await this.runStepOnce(step, attempt);
      if (verdict.kind !== 'problem') return verdict;
      last = verdict;

      // A recoverable condition may have appeared *because* of what we just did.
      const obs = await this.observe(`after-problem-${step.id}`);
      const cls = classify(obs, this.rules, { params: this.params, stepId: step.id, completed: this.completed });
      const handled = await this.handleClassification(cls, obs, step.id);
      if (handled.kind === 'terminal') return handled;
      if (handled.kind === 'recovered') continue;

      if (attempt < maxAttempts) {
        this.session.journal.event('note', { stepId: step.id, note: `retrying step (attempt ${attempt + 1}/${maxAttempts})` });
      }
    }
    return last!;
  }

  private async runStepOnce(step: Step, attempt: number): Promise<StepVerdict> {
    const t = Date.now();
    const base: StepRecord = {
      stepId: step.id, intent: step.intent, action: step.action.kind,
      status: 'failed', attempts: attempt, durationMs: 0,
    };
    const done = (patch: Partial<StepRecord>): StepRecord => ({ ...base, ...patch, durationMs: Date.now() - t });

    let obs = await this.observe(`before-${step.id}`);

    // Classify before acting: never type into a screen we have misidentified.
    if (!this.inRecovery) {
      const pre = classify(obs, this.rules, { params: this.params, stepId: step.id, completed: this.completed });
      const handledPre = await this.handleClassification(pre, obs, step.id);
      if (handledPre.kind === 'terminal') return handledPre;
      if (handledPre.kind === 'recovered') obs = await this.observe(`after-recovery-${step.id}`);
    }

    // Read-only actions never touch the surface driver.
    switch (step.action.kind) {
      case 'waitFor': {
        const pred = step.action.predicate;
        const ok = await this.pollPredicate(pred, step.timeoutMs, `waitFor-${step.id}`);
        return ok
          ? { kind: 'ok', record: done({ status: 'ok', checkpoint: { ok: true, detail: describePredicate(pred) } }) }
          : {
              kind: 'problem', code: 'CHECKPOINT_FAILED',
              message: `waitFor timed out after ${step.timeoutMs}ms`,
              expected: describePredicate(pred), observed: this.observedSummary(),
              record: done({ status: 'failed' }),
            };
      }
      case 'assert': {
        const r = evaluate(step.action.predicate, obs, this.params);
        this.session.journal.event(r.ok ? 'checkpoint' : 'checkpoint.fail', { stepId: step.id, detail: r.detail });
        return r.ok
          ? { kind: 'ok', record: done({ status: 'ok', checkpoint: r }) }
          : {
              kind: 'problem', code: 'CHECKPOINT_FAILED', message: `assertion failed: ${r.detail}`,
              expected: describePredicate(step.action.predicate), observed: this.observedSummary(),
              record: done({ status: 'failed', checkpoint: r }),
            };
      }
      case 'extract': {
        const missing = this.extractInto(step.action.outputs, obs);
        return missing.length === 0
          ? { kind: 'ok', record: done({ status: 'ok', note: `extracted ${step.action.outputs.join(', ')}` }) }
          : {
              kind: 'problem', code: 'OUTPUT_MISSING', message: `could not extract: ${missing.join('; ')}`,
              observed: this.observedSummary(), record: done({ status: 'failed' }),
            };
      }
      default:
        break;
    }

    // Actions with a target need resolution first.
    let control: Control | undefined;
    let matchInfo: StepRecord['match'];
    let targetDesc: string | undefined;

    if ('target' in step.action) {
      const target = this.interpolateTarget(step.action.target);
      targetDesc = describeTarget(target);
      const resolved = await this.resolveWithWait(target, step.timeoutMs, step.id);
      if (resolved.status !== 'resolved') {
        if (step.optional) {
          this.session.journal.event('note', { stepId: step.id, note: 'optional step skipped: target absent' });
          return { kind: 'skipped', record: done({ status: 'skipped', target: targetDesc, note: 'optional target absent' }) };
        }
        const code: FailureCode = resolved.status === 'ambiguous' ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND';
        const observed = resolved.status === 'ambiguous'
          ? resolved.candidates.map((c) => `${c.control.role} "${c.control.name || c.control.labels[0] || ''}" (${c.score.toFixed(2)})`).join(' | ')
          : `best score ${resolved.best?.score.toFixed(2) ?? 'n/a'} over ${resolved.considered} controls`;
        this.session.journal.event('resolve.fail', { stepId: step.id, target: targetDesc, status: resolved.status, observed });
        return {
          kind: 'problem', code, message: `could not target ${targetDesc}`,
          expected: targetDesc, observed, record: done({ status: 'failed', target: targetDesc }),
        };
      }
      control = resolved.control;
      matchInfo = { score: round(resolved.score), runnerUp: resolved.runnerUp !== undefined ? round(resolved.runnerUp) : undefined };
      this.session.journal.event('resolve', {
        stepId: step.id, target: targetDesc, ref: control.ref,
        score: matchInfo.score, runnerUp: matchInfo.runnerUp, why: resolved.why,
      });
    }

    const act = await this.dispatchAction(step, control);
    if (!act.ok) {
      if (act.code === 'CONFIRMATION_REQUIRED') {
        return {
          kind: 'problem', code: 'CONFIRMATION_REQUIRED', message: act.reason,
          expected: `human approval for a ${step.risk} step`, observed: this.observedSummary(),
          record: done({ status: 'failed', target: targetDesc, match: matchInfo }),
        };
      }
      return {
        kind: 'problem', code: act.code === 'TIMEOUT' ? 'TIMEOUT' : act.code, message: act.reason,
        observed: this.observedSummary(),
        record: done({ status: 'failed', target: targetDesc, match: matchInfo }),
      };
    }

    // Post-condition. A step without a checkpoint is a step that assumed.
    if (step.checkpoint) {
      const ok = await this.pollPredicate(step.checkpoint, step.timeoutMs, `checkpoint-${step.id}`);
      const detail = evaluate(step.checkpoint, this.lastObs ?? obs, this.params);
      if (!ok) {
        return {
          kind: 'problem', code: 'CHECKPOINT_FAILED',
          message: `checkpoint did not hold within ${step.timeoutMs}ms`,
          expected: describePredicate(step.checkpoint), observed: this.observedSummary(),
          record: done({ status: 'failed', target: targetDesc, match: matchInfo, checkpoint: detail }),
        };
      }
      return { kind: 'ok', record: done({ status: 'ok', target: targetDesc, match: matchInfo, checkpoint: detail }) };
    }

    return { kind: 'ok', record: done({ status: 'ok', target: targetDesc, match: matchInfo }) };
  }

  private async dispatchAction(step: Step, control: Control | undefined): Promise<ActOutcome> {
    const a = step.action;
    const common = {
      risk: step.risk, stepId: step.id, describe: step.intent,
      confirmed: this.req.confirmed, humanApproved: this.humanApproved.has(step.id),
    };
    switch (a.kind) {
      case 'navigate':
        return this.session.act({ ...common, kind: 'navigate', locus: interpolate(a.locus, this.params) });
      case 'click':
        return this.session.act({ ...common, kind: 'click', ref: control!.ref });
      case 'type': {
        const text = this.resolveText(a.text);
        if (text === undefined) {
          return { ok: false, code: 'SURFACE_ERROR', reason: `step ${step.id}: text source unresolved` };
        }
        return this.session.act({
          ...common, kind: 'type', ref: control!.ref, text,
          clearFirst: a.clearFirst, pressEnter: a.pressEnter,
        });
      }
      case 'select': {
        const value = this.resolveText(a.value);
        return this.session.act({ ...common, kind: 'select', ref: control!.ref, value: value ?? '' });
      }
      case 'press':
        return this.session.act({ ...common, kind: 'press', key: a.key });
      case 'dialog':
        return this.session.act({ ...common, kind: 'dialog', decision: a.decision });
      default:
        return { ok: false, code: 'SURFACE_ERROR', reason: `unhandled action kind` };
    }
  }

  /** Secrets are resolved from the environment at replay time, by name. */
  private resolveText(src: { kind: 'param'; param: string } | { kind: 'literal'; value: string } | { kind: 'secretRef'; env: string }): string | undefined {
    switch (src.kind) {
      case 'literal': return interpolate(src.value, this.params);
      case 'param': {
        const v = this.params[src.param];
        return v === undefined ? undefined : String(v);
      }
      case 'secretRef': {
        const v = process.env[src.env];
        if (v) this.session.redactor.registerValue(v, 'secret');
        return v;
      }
    }
  }

  private interpolateTarget(t: TargetDescriptor): TargetDescriptor {
    return interpolateTarget(t, this.params);
  }

  // -- waiting: poll asserted state, never sleep on faith -------------------

  private async pollPredicate(pred: Parameters<typeof evaluate>[0], timeoutMs: number, label: string): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const obs = await this.observe(label, { quiet: true });
      const r = evaluate(pred, obs, this.params);
      if (r.ok) {
        this.session.journal.event('checkpoint', { label, detail: r.detail });
        return true;
      }
      if (Date.now() >= deadline) {
        this.session.journal.event('checkpoint.fail', { label, detail: r.detail, timeoutMs });
        return false;
      }
      await sleep(POLL_MS);
    }
  }

  private async resolveWithWait(target: TargetDescriptor, timeoutMs: number, stepId: string) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const obs = await this.observe(`resolve-${stepId}`, { quiet: true });
      const r = resolveTarget(obs, target);
      if (r.status === 'resolved') return r;
      // Ambiguity will not resolve itself by waiting; a missing control might.
      if (r.status === 'ambiguous' || Date.now() >= deadline) return r;
      await sleep(POLL_MS);
    }
  }

  private async observe(label: string, opts: { quiet?: boolean } = {}): Promise<Observation> {
    const obs = opts.quiet ? await this.session.surface.observe() : await this.session.observe(label);
    this.lastObs = obs;
    return obs;
  }

  private observedSummary(): string {
    const o = this.lastObs;
    if (!o) return 'no observation';
    const alert = o.controls.find((c) => c.role === 'alert' || /^(ERR|SEC|MCX)-/.test(c.name));
    return [
      `locus=${o.locus}`,
      `title="${this.session.redactor.text(o.title)}"`,
      alert ? `alert="${this.session.redactor.text(alert.name)}"` : undefined,
      o.pendingDialog ? `dialog="${this.session.redactor.text(o.pendingDialog.message)}"` : undefined,
      `controls=${o.controls.length}`,
    ].filter(Boolean).join(' ');
  }

  // -- classification handling ----------------------------------------------

  private async handleClassification(
    cls: Classification, obs: Observation, stepId: string,
  ): Promise<{ kind: 'none' } | { kind: 'recovered' } | { kind: 'terminal'; result: ReplayResult }> {
    switch (cls.kind) {
      case 'none':
        return { kind: 'none' };

      case 'outcome': {
        this.session.journal.event('monitor.outcome', { code: cls.rule.code, stepId, detail: cls.detail });
        if (cls.rule.outputs.length > 0) this.extractInto(cls.rule.outputs, obs);
        return {
          kind: 'terminal',
          result: this.build('business_outcome', {
            outcome: { code: cls.rule.code, message: interpolate(cls.rule.message, this.params) },
          }),
        };
      }

      case 'fault': {
        this.session.journal.event('monitor.fault', { code: cls.rule.code, stepId, detail: cls.detail });
        await this.captureFailureEvidence(`fault-${cls.rule.code}`);
        if (cls.rule.escalate && this.deps.escalator) {
          const outcome = await this.escalate('APP_FAULT', cls.rule.message, stepId, obs, [
            'Clear the application error and return to the previous screen',
            'Or abort the run so the caller sees a hard failure',
          ]);
          if (outcome.kind !== 'terminal') return { kind: 'recovered' };
          return { kind: 'terminal', result: outcome.result };
        }
        return {
          kind: 'terminal',
          result: this.build('failure', {
            failure: {
              code: 'APP_FAULT', message: interpolate(cls.rule.message, this.params),
              stepId, expected: 'a usable application screen', observed: this.observedSummary(),
            },
          }),
        };
      }

      case 'recovery': {
        const rule = cls.rule;
        if (this.ledger.exhausted(rule)) {
          this.session.journal.event('monitor.recovery', { code: rule.code, stepId, exhausted: true });
          await this.captureFailureEvidence(`recovery-exhausted-${rule.code}`);
          if (this.deps.escalator) {
            const outcome = await this.escalate('RECOVERY_EXHAUSTED', `${rule.message} (recovery exhausted)`, stepId, obs, [
              'Clear the blocking condition manually, then resume automation',
              'Or abort the run',
            ]);
            if (outcome.kind !== 'terminal') return { kind: 'recovered' };
            return { kind: 'terminal', result: outcome.result };
          }
          return {
            kind: 'terminal',
            result: this.build('failure', {
              failure: {
                code: 'RECOVERY_EXHAUSTED',
                message: `${rule.message}: condition recurred after ${rule.maxAttempts} attempt(s)`,
                stepId, observed: this.observedSummary(),
              },
            }),
          };
        }

        const attempt = this.ledger.attempt(rule.code);
        this.session.journal.event('recovery.start', { code: rule.code, attempt, stepId, detail: cls.detail });
        let ok = true;
        this.inRecovery = true;
        try {
          for (const action of rule.actions) {
            const v = await this.runStepOnce({ ...action, retries: 0 }, 1);
            if (v.kind === 'problem') { ok = false; break; }
            if (v.kind === 'terminal') return v;
          }
        } finally {
          this.inRecovery = false;
        }
        this.recoveries.push({ code: rule.code, attempt, ok, detail: cls.detail });
        this.session.journal.event('recovery.end', { code: rule.code, attempt, ok });
        return ok ? { kind: 'recovered' } : { kind: 'none' };
      }
    }
  }

  // -- escalation ------------------------------------------------------------

  private async escalate(
    reason: InterventionReason, summary: string, stepId: string, obs: Observation, askedFor: string[],
  ): Promise<{ kind: 'retry' } | { kind: 'skip' } | { kind: 'terminal'; result: ReplayResult }> {
    const esc = this.deps.escalator!;
    const step = this.cap.steps.find((s) => s.id === stepId);
    const req = await esc.raise(this.session, {
      mode: 'replay', reason, summary, askedFor, observation: obs,
      capability: { id: this.cap.id, name: this.cap.name, version: this.cap.version },
      tenant: this.req.tenant,
      step: step ? { id: step.id, intent: step.intent, action: step.action.kind } : undefined,
    });
    const resolved = await esc.waitForResolution(this.session, req.id);
    const decision = resolved.resolution?.decision ?? 'aborted';
    this.escalation = {
      interventionId: req.id, reason, stepId,
      resolvedBy: resolved.resolution?.by,
      resumed: decision === 'resumed' || decision === 'completed_manually',
    };

    if (decision === 'aborted' || decision === 'denied') {
      return {
        kind: 'terminal',
        result: this.build('escalated', {
          failure: {
            code: decision === 'denied' ? 'CONFIRMATION_REQUIRED' : mapReasonToFailure(reason),
            message: `operator ${decision}: ${resolved.resolution?.note ?? 'no note'}`,
            stepId, observed: this.observedSummary(),
          },
        }),
      };
    }

    // A human may have moved the UI arbitrarily far. Re-establish where we are
    // from the artifact's own assertions rather than assuming.
    const after = await this.observe(`after-handback-${stepId}`);
    if (reason === 'CONFIRMATION_REQUIRED') {
      this.humanApproved.add(stepId);
      return { kind: 'retry' };
    }
    if (evaluate(this.cap.successCondition, after, this.params).ok) {
      this.session.journal.event('note', { stepId, note: 'operator advanced the flow to its success state' });
      return { kind: 'skip' };
    }
    if (step?.checkpoint && evaluate(step.checkpoint, after, this.params).ok) {
      this.session.journal.event('note', { stepId, note: 'operator satisfied this step; continuing' });
      return { kind: 'skip' };
    }
    return { kind: 'retry' };
  }

  /**
   * A step-level problem is offered to a human before it becomes a failure. This
   * is the "detect stuck → route → take over → resume" seam for replay.
   */
  private async problemToResult(step: Step, v: Extract<StepVerdict, { kind: 'problem' }>): Promise<ReplayResult> {
    await this.captureFailureEvidence(`${v.code}-${step.id}`);

    if (this.deps.escalator) {
      const obs = this.lastObs ?? await this.observe(`escalate-${step.id}`);
      const askedFor = v.code === 'CONFIRMATION_REQUIRED'
        ? [`Approve this ${step.risk} step: ${step.intent}`, 'Or abort the run']
        : [
            `Complete this step manually: ${step.intent}`,
            'Then hand control back to resume the remaining steps',
            'Or abort the run so the caller sees a hard failure',
          ];
      const outcome = await this.escalate(reasonFor(v.code), `${v.code}: ${v.message}`, step.id, obs, askedFor);
      if (outcome.kind === 'terminal') return outcome.result;

      if (outcome.kind === 'skip') {
        this.records.push({
          stepId: step.id, intent: step.intent, action: step.action.kind,
          status: 'recovered', attempts: v.record.attempts, durationMs: 0,
          note: 'completed by human operator',
        });
        this.completed.add(step.id);
        return this.continueFrom(step.id);
      }

      const retry = await this.runStepWithRetries(step);
      if (retry.kind === 'terminal') return retry.result;
      this.records.push(retry.record);
      if (retry.kind === 'problem') {
        return this.build('failure', {
          failure: {
            code: retry.code, message: `${retry.message} (after operator handback)`,
            stepId: step.id, expected: retry.expected, observed: retry.observed,
          },
        });
      }
      this.completed.add(step.id);
      return this.continueFrom(step.id);
    }

    return this.build('failure', {
      failure: { code: v.code, message: v.message, stepId: step.id, expected: v.expected, observed: v.observed },
    });
  }

  /** Resume the step loop after an escalation resolved mid-flow. */
  private async continueFrom(stepId: string): Promise<ReplayResult> {
    const idx = this.cap.steps.findIndex((s) => s.id === stepId);
    for (let i = idx + 1; i < this.cap.steps.length; i++) {
      const step = this.cap.steps[i]!;
      if (this.session.gate.expired()) return this.fail('TIMEOUT', 'duration budget exhausted after handback', step.id);
      const verdict = await this.runStepWithRetries(step);
      if (verdict.kind === 'terminal') return verdict.result;
      this.records.push(verdict.record);
      if (verdict.kind === 'problem') return this.problemToResult(step, verdict);
      this.completed.add(step.id);
    }
    return this.finishSuccessfully();
  }

  // -- completion ------------------------------------------------------------

  private async finishSuccessfully(): Promise<ReplayResult> {
    const ok = await this.pollPredicate(this.cap.successCondition, 8000, 'success-condition');
    const obs = this.lastObs ?? await this.observe('final');

    if (!ok) {
      const cls = classify(obs, this.rules, { params: this.params, completed: this.completed });
      const handled = await this.handleClassification(cls, obs, 'final');
      if (handled.kind === 'terminal') return handled.result;
      await this.captureFailureEvidence('success-condition-failed');
      return this.build('failure', {
        failure: {
          code: 'SUCCESS_CONDITION_FAILED',
          message: 'all steps ran but the capability success condition did not hold',
          expected: describePredicate(this.cap.successCondition),
          observed: this.observedSummary(),
        },
      });
    }

    const pending = this.cap.contract.outputs.filter((o) => !this.extracted.has(o.name)).map((o) => o.name);
    const missing = this.extractInto(pending, obs);
    if (missing.length > 0) {
      await this.captureFailureEvidence('output-missing');
      return this.build('failure', {
        failure: {
          code: 'OUTPUT_MISSING', message: `declared output(s) not extractable: ${missing.join('; ')}`,
          observed: this.observedSummary(),
        },
      });
    }
    return this.build('success', {});
  }

  private extractInto(names: string[], obs: Observation): string[] {
    const missing: string[] = [];
    for (const name of names) {
      const spec = this.cap.contract.outputs.find((o) => o.name === name);
      if (!spec) { missing.push(`${name} (not declared)`); continue; }
      const r = extractOutput(obs, spec, this.params);
      if (r.ok) {
        this.outputs[name] = r.value;
        this.extracted.add(name);
        // Values classified as regulated data are returned to the caller but
        // never written to the journal in the clear.
        if (spec.sensitivity === 'pii' || spec.sensitivity === 'secret') {
          this.session.redactor.registerValue(String(r.value), spec.sensitivity);
        }
        this.session.journal.event('extract', { name, type: spec.type, sensitivity: spec.sensitivity, value: String(r.value) });
      } else if (spec.required) {
        missing.push(r.reason);
      } else {
        this.outputs[name] = null;
        this.extracted.add(name);
      }
    }
    return missing;
  }

  private async captureFailureEvidence(label: string): Promise<void> {
    await this.session.journal.saveScreenshot(this.session.surface, label);
    if (this.lastObs) await this.session.journal.saveObservation(this.lastObs, label);
    this.failureSnapshot = await this.session.journal.saveSourceSnapshot(this.session.surface, label);
  }

  // -- result construction ---------------------------------------------------

  private build(status: ReplayResult['status'], extra: Partial<ReplayResult>): ReplayResult {
    const endedAt = new Date().toISOString();
    const result: ReplayResult = {
      runId: this.session.journal.meta.runId,
      capability: { id: this.cap.id, name: this.cap.name, version: this.cap.version },
      tenant: this.req.tenant,
      status,
      outputs: this.outputs,
      steps: this.records,
      recoveries: this.recoveries,
      drift: this.drift,
      timing: { startedAt: this.startedAt, endedAt, durationMs: Date.now() - this.t0 },
      evidence: {
        dir: this.session.journal.relPath(this.session.journal.dir),
        journal: this.session.journal.relPath(this.session.journal.journalPath),
        screenshots: this.session.journal.screenshots,
        failureSnapshot: this.failureSnapshot,
      },
      ...(this.escalation ? { escalation: this.escalation } : {}),
      ...extra,
    };
    return result;
  }

  private fail(code: FailureCode, message: string, stepId?: string): ReplayResult {
    return this.build('failure', { failure: { code, message, stepId } });
  }

  private failFromAct(a: Extract<ActOutcome, { ok: false }>): ReplayResult {
    const code: FailureCode = a.code === 'TIMEOUT' ? 'TIMEOUT' : a.code;
    return this.fail(code, a.reason);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (n: number): number => Math.round(n * 1000) / 1000;

function reasonFor(code: FailureCode): InterventionReason {
  switch (code) {
    case 'TARGET_NOT_FOUND': return 'TARGET_NOT_FOUND';
    case 'AMBIGUOUS_TARGET': return 'AMBIGUOUS_TARGET';
    case 'CHECKPOINT_FAILED': return 'CHECKPOINT_FAILED';
    case 'CONFIRMATION_REQUIRED': return 'CONFIRMATION_REQUIRED';
    case 'DIALOG_UNANSWERED': return 'DIALOG_UNANSWERED';
    case 'APP_FAULT': return 'APP_FAULT';
    case 'POLICY_DENIED': return 'POLICY_DENIED';
    default: return 'UNKNOWN_STATE';
  }
}

function mapReasonToFailure(reason: InterventionReason): FailureCode {
  switch (reason) {
    case 'TARGET_NOT_FOUND': return 'TARGET_NOT_FOUND';
    case 'AMBIGUOUS_TARGET': return 'AMBIGUOUS_TARGET';
    case 'CHECKPOINT_FAILED': return 'CHECKPOINT_FAILED';
    case 'RECOVERY_EXHAUSTED': return 'RECOVERY_EXHAUSTED';
    case 'CONFIRMATION_REQUIRED': return 'CONFIRMATION_REQUIRED';
    case 'DIALOG_UNANSWERED': return 'DIALOG_UNANSWERED';
    case 'APP_FAULT': return 'APP_FAULT';
    case 'POLICY_DENIED': return 'POLICY_DENIED';
    default: return 'CHECKPOINT_FAILED';
  }
}
