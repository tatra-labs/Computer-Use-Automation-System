/**
 * Raising an intervention and waiting for a human.
 *
 * The engine never transfers control itself. It publishes an intervention and
 * blocks. Control moves when a human actually takes it — through the operator
 * console, or through a ScriptedOperator standing in for one — and moves back
 * when they release it. That ordering matters: an automation that pre-emptively
 * dropped the lease would leave a live banking session with nobody in control.
 */
import type { Observation } from '../core/target.js';
import type { Session } from '../session/session.js';
import {
  buildIntervention, InterventionReason, InterventionRequest, InterventionStore,
} from './intervention.js';

export interface EscalationInput {
  mode: 'discovery' | 'replay';
  reason: InterventionReason;
  summary: string;
  askedFor: string[];
  observation: Observation;
  goal?: string;
  capability?: { id: string; name: string; version: number };
  tenant?: string | null;
  step?: { id: string; intent: string; action: string; target?: string };
}

export class Escalator {
  constructor(
    private store: InterventionStore,
    private opts: { waitMs: number; pollMs?: number },
  ) {}

  async raise(session: Session, input: EscalationInput): Promise<InterventionRequest> {
    const screenshot = await session.journal.saveScreenshot(session.surface, `escalation-${input.reason}`);
    const req = buildIntervention({
      ...input,
      runId: session.journal.meta.runId,
      sessionId: session.id,
      screenshot,
      permitted: {
        actions: session.gate.policy.allowlist.actions,
        loci: session.gate.policy.allowlist.loci,
      },
      lease: session.lease.current,
      redactor: session.redactor,
    });
    this.store.open(req);
    session.journal.event('escalation.raised', {
      interventionId: req.id, reason: req.reason, summary: req.summary,
      stepId: input.step?.id, screenshot, askedFor: req.askedFor,
    });
    return req;
  }

  /**
   * Blocks until a human resolves the intervention, or the wait budget expires.
   * A timeout is itself a resolution ('abandoned') so the run always terminates
   * with a defined state rather than hanging on an absent operator.
   */
  async waitForResolution(session: Session, id: string): Promise<InterventionRequest> {
    const pollMs = this.opts.pollMs ?? 250;
    const deadline = Date.now() + this.opts.waitMs;

    for (;;) {
      const cur = this.store.get(id);
      if (!cur) throw new Error(`intervention ${id} vanished`);
      if (cur.status === 'resolved' || cur.status === 'abandoned') {
        // Adopt whatever epoch the handback produced before touching the surface.
        session.adoptCurrentEpoch();
        session.journal.event('escalation.resolved', {
          interventionId: id,
          decision: cur.resolution?.decision ?? 'abandoned',
          by: cur.resolution?.by,
          note: cur.resolution?.note,
          humanActions: cur.resolution?.humanActions?.length ?? 0,
          leaseEpoch: session.automationEpoch,
        });
        for (const a of cur.resolution?.humanActions ?? []) {
          session.journal.event('human.action', { at: a.at, kind: a.kind, detail: a.detail });
        }
        return cur;
      }
      if (Date.now() > deadline) {
        const timedOut = this.store.update(id, {
          status: 'abandoned',
          resolution: {
            at: new Date().toISOString(), by: 'system', decision: 'aborted',
            note: `no operator responded within ${this.opts.waitMs}ms`,
            humanActions: [...session.lease.recordedHumanActions],
          },
        });
        session.adoptCurrentEpoch();
        session.journal.event('escalation.resolved', { interventionId: id, decision: 'timeout' });
        return timedOut;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
