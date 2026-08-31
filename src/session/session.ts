/**
 * The session: one live surface, one control lease, one policy gate, one journal.
 *
 * `Session.act()` is the single choke point through which every action in the
 * system passes — discovery and replay alike. Nothing else is allowed to touch
 * the surface's action methods. That gives us exactly one place where:
 *   - the allowlist and risk policy are enforced,
 *   - the control lease is verified *before and after* the action (so a human
 *     taking over mid-step is detected rather than racing us),
 *   - the action is journalled with its reason.
 *
 * The double lease check is deliberate. Checking only beforehand leaves a window
 * where an operator grabs control while a click is in flight; checking after
 * tells us the result cannot be trusted.
 */
import { randomUUID } from 'node:crypto';
import type { Observation } from '../core/target.js';
import type { Risk } from '../core/artifact.js';
import { ActionKind, PolicyGate } from '../policy/policy.js';
import type { Redactor } from '../policy/redact.js';
import type { Journal } from '../obs/journal.js';
import { ControlLease, ControlLostError, Controller } from './lease.js';
import { Surface, SurfaceError } from '../surface/surface.js';

export interface ActRequest {
  kind: ActionKind;
  risk: Risk;
  /** Human-readable description, journalled verbatim (after redaction). */
  describe: string;
  stepId?: string;
  ref?: string;
  text?: string;
  locus?: string;
  key?: string;
  value?: string;
  decision?: 'accept' | 'dismiss';
  clearFirst?: boolean;
  pressEnter?: boolean;
  /** The caller authorized risky work for this invocation. */
  confirmed?: boolean;
  /** A human already approved this specific step through escalation. */
  humanApproved?: boolean;
}

export type ActFailure =
  | 'POLICY_DENIED'
  | 'CONFIRMATION_REQUIRED'
  | 'CONTROL_LOST'
  | 'SURFACE_ERROR'
  | 'TIMEOUT';

export type ActOutcome = { ok: true } | { ok: false; code: ActFailure; reason: string };

export interface SessionOptions {
  surface: Surface;
  gate: PolicyGate;
  redactor: Redactor;
  journal: Journal;
  holder: string;
}

export class Session {
  readonly id: string;
  readonly surface: Surface;
  readonly lease: ControlLease;
  readonly gate: PolicyGate;
  readonly redactor: Redactor;
  readonly journal: Journal;
  /** The epoch automation believes it holds. Updated only on a real handback. */
  private epoch: number;

  constructor(opts: SessionOptions) {
    this.id = 'ses_' + randomUUID().slice(0, 8);
    this.surface = opts.surface;
    this.gate = opts.gate;
    this.redactor = opts.redactor;
    this.journal = opts.journal;
    this.lease = new ControlLease(opts.holder);
    this.epoch = this.lease.epoch;
    this.lease.onChange((s) => {
      this.journal.event('lease.transfer', { owner: s.owner, epoch: s.epoch, holder: s.holder, reason: s.reason });
    });
  }

  get automationEpoch(): number { return this.epoch; }
  get inControl(): Controller { return this.lease.owner; }
  get automationHasControl(): boolean { return this.lease.held('automation', this.epoch); }

  /** Called after a human hands control back, to adopt the new epoch. */
  adoptCurrentEpoch(): number {
    this.epoch = this.lease.epoch;
    return this.epoch;
  }

  async observe(label = 'observe'): Promise<Observation> {
    const obs = await this.surface.observe();
    this.journal.event('observe', {
      label,
      locus: obs.locus,
      title: obs.title,
      controls: obs.controls.length,
      frames: obs.frames.map((f) => f.name),
      fingerprint: obs.fingerprint,
      pendingDialog: obs.pendingDialog?.message,
    });
    return obs;
  }

  /**
   * The choke point. Returns a typed outcome rather than throwing for the
   * expected refusals, because "policy said no" is a result the caller must
   * handle, not an exception to bubble.
   */
  async act(req: ActRequest): Promise<ActOutcome> {
    const locus = req.kind === 'navigate' ? (req.locus ?? '') : this.surface.currentLocus();

    const decision = this.gate.check({
      kind: req.kind,
      risk: req.risk,
      locus,
      confirmed: !!req.confirmed,
      humanApproved: !!req.humanApproved,
    });
    if (!decision.allow) {
      this.journal.event('policy.deny', { stepId: req.stepId, kind: req.kind, risk: req.risk, locus, reason: decision.reason });
      return { ok: false, code: 'POLICY_DENIED', reason: decision.reason };
    }
    if (decision.requiresConfirmation) {
      this.journal.event('policy.check', { stepId: req.stepId, kind: req.kind, risk: req.risk, requiresConfirmation: true, reason: decision.reason });
      return { ok: false, code: 'CONFIRMATION_REQUIRED', reason: decision.reason };
    }

    if (req.kind === 'navigate') {
      const budget = this.gate.countNavigation();
      if (!budget.allow) return { ok: false, code: 'POLICY_DENIED', reason: budget.reason };
    }
    if (this.gate.expired()) {
      return { ok: false, code: 'TIMEOUT', reason: 'capability duration budget exhausted' };
    }

    try {
      this.lease.assertHeld('automation', this.epoch);
    } catch (e) {
      const err = e as ControlLostError;
      return { ok: false, code: 'CONTROL_LOST', reason: err.message };
    }

    const startedAt = Date.now();
    try {
      await this.dispatch(req);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.journal.event('action.error', { stepId: req.stepId, kind: req.kind, describe: req.describe, error: msg });
      return { ok: false, code: 'SURFACE_ERROR', reason: msg };
    }

    // Post-check: if control moved while we were acting, the surface state is no
    // longer ours to reason about.
    if (!this.lease.held('automation', this.epoch)) {
      this.journal.event('action.error', { stepId: req.stepId, kind: req.kind, error: 'control transferred during action' });
      return { ok: false, code: 'CONTROL_LOST', reason: 'control transferred while the action was in flight' };
    }

    this.journal.event('action', {
      stepId: req.stepId,
      kind: req.kind,
      risk: req.risk,
      describe: req.describe,
      // Typed text is redacted by the journal; log only its shape as a tripwire.
      textLength: req.text?.length,
      locus: this.surface.currentLocus(),
      durationMs: Date.now() - startedAt,
    });
    return { ok: true };
  }

  private async dispatch(req: ActRequest): Promise<void> {
    switch (req.kind) {
      case 'navigate':
        if (!req.locus) throw new SurfaceError('navigate without a locus');
        return this.surface.navigate(req.locus);
      case 'click':
        if (!req.ref) throw new SurfaceError('click without a ref');
        return this.surface.click(req.ref);
      case 'type':
        if (!req.ref) throw new SurfaceError('type without a ref');
        return this.surface.type(req.ref, req.text ?? '', {
          clearFirst: req.clearFirst ?? true,
          pressEnter: req.pressEnter ?? false,
        });
      case 'select':
        if (!req.ref) throw new SurfaceError('select without a ref');
        return this.surface.select(req.ref, req.value ?? '');
      case 'press':
        return this.surface.press(req.key ?? 'Enter');
      case 'dialog':
        return this.surface.answerDialog(req.decision ?? 'dismiss');
      // observe / screenshot / waitFor / assert / extract do not touch the
      // surface through act(); they are read paths handled by the engine.
      default:
        throw new SurfaceError(`act() does not dispatch kind "${req.kind}"`);
    }
  }

  async close(): Promise<void> {
    await this.surface.close();
  }
}

/**
 * Sessions the operator console can reach. A run registers itself while live and
 * deregisters when it ends, so the console can never be handed a dead page.
 */
export class SessionRegistry {
  private live = new Map<string, { surface: Surface; lease: ControlLease; redactor: Redactor }>();

  register(s: Session): () => void {
    this.live.set(s.id, { surface: s.surface, lease: s.lease, redactor: s.redactor });
    return () => this.live.delete(s.id);
  }

  resolveSession(sessionId: string) {
    return this.live.get(sessionId);
  }
}
