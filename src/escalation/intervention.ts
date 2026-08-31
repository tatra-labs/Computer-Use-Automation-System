/**
 * Intervention requests: the seam between "the automation is stuck" and "a human
 * is driving".
 *
 * An intervention carries enough context for an operator to act without reading
 * code or logs — which capability, which step, why it stopped, what the screen
 * looks like — and it carries a *resolution* back. The bus is deliberately a
 * plain in-process store plus a JSON file per request: the shape of the payload
 * and the state machine are the parts worth getting right, and a queue can be
 * swapped in behind the same interface.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Observation } from '../core/target.js';
import type { HumanAction, LeaseState } from '../session/lease.js';

export type InterventionReason =
  | 'TARGET_NOT_FOUND'      // recorded locator no longer resolves
  | 'AMBIGUOUS_TARGET'      // two candidates too close to choose safely
  | 'CHECKPOINT_FAILED'     // action ran, expected state never arrived
  | 'RECOVERY_EXHAUSTED'    // known bad state kept recurring
  | 'UNKNOWN_STATE'         // nothing in the artifact describes this screen
  | 'CONFIRMATION_REQUIRED' // risky/irreversible step needs a person to decide
  | 'DIALOG_UNANSWERED'
  | 'APP_FAULT'
  | 'AGENT_STUCK'           // discovery loop made no progress
  | 'POLICY_DENIED';

export type InterventionStatus = 'open' | 'operator_in_control' | 'resolved' | 'abandoned';

export interface InterventionRequest {
  id: string;
  createdAt: string;
  status: InterventionStatus;
  mode: 'discovery' | 'replay';
  reason: InterventionReason;
  /** One sentence an operator can act on. */
  summary: string;
  runId: string;
  sessionId: string;
  goal?: string;
  capability?: { id: string; name: string; version: number };
  tenant?: string | null;
  step?: { id: string; intent: string; action: string; target?: string };
  /** Redacted snapshot of what the automation could see. */
  state: {
    locus: string;
    title: string;
    visibleText: string;
    controlSummary: string[];
    pendingDialog?: { kind: string; message: string };
  };
  screenshot?: string;
  /** What the operator is being asked to do, in order of preference. */
  askedFor: string[];
  /** What the operator is permitted to do — mirrors the policy allowlist. */
  permitted: { actions: string[]; loci: string[] };
  lease: LeaseState;
  resolution?: InterventionResolution;
}

export interface InterventionResolution {
  at: string;
  by: string;
  decision: 'resumed' | 'completed_manually' | 'aborted' | 'denied';
  note: string;
  /** Everything the human did on the live session, redacted. */
  humanActions: HumanAction[];
}

export interface Redactorish { text(s: string): string; json<T>(v: T): T }

/**
 * Builds the payload. Kept separate from transport so the same context bundle
 * can be posted to a queue, a ticket, or the console in this repo.
 */
export function buildIntervention(input: {
  mode: 'discovery' | 'replay';
  reason: InterventionReason;
  summary: string;
  runId: string;
  sessionId: string;
  goal?: string;
  capability?: { id: string; name: string; version: number };
  tenant?: string | null;
  step?: { id: string; intent: string; action: string; target?: string };
  observation: Observation;
  screenshot?: string;
  askedFor: string[];
  permitted: { actions: string[]; loci: string[] };
  lease: LeaseState;
  redactor: Redactorish;
}): InterventionRequest {
  const r = input.redactor;
  return {
    id: 'int_' + randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    status: 'open',
    mode: input.mode,
    reason: input.reason,
    summary: r.text(input.summary),
    runId: input.runId,
    sessionId: input.sessionId,
    goal: input.goal ? r.text(input.goal) : undefined,
    capability: input.capability,
    tenant: input.tenant ?? null,
    step: input.step ? { ...input.step, intent: r.text(input.step.intent) } : undefined,
    state: {
      locus: input.observation.locus,
      title: r.text(input.observation.title),
      visibleText: r.text(input.observation.text).slice(0, 4000),
      controlSummary: input.observation.controls.slice(0, 60).map(
        (c) => `${c.role} "${r.text(c.name || c.labels[0] || '')}"${c.frame.length ? ` @${c.frame.join('/')}` : ''}`,
      ),
      pendingDialog: input.observation.pendingDialog
        ? { kind: input.observation.pendingDialog.kind, message: r.text(input.observation.pendingDialog.message) }
        : undefined,
    },
    screenshot: input.screenshot,
    askedFor: input.askedFor,
    permitted: input.permitted,
    lease: input.lease,
  };
}

/** In-process store; every mutation is also mirrored to disk as evidence. */
export class InterventionStore {
  private items = new Map<string, InterventionRequest>();
  private watchers: Array<(i: InterventionRequest) => void> = [];

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  open(req: InterventionRequest): InterventionRequest {
    this.items.set(req.id, req);
    this.persist(req);
    for (const w of this.watchers) w(req);
    return req;
  }

  get(id: string): InterventionRequest | undefined { return this.items.get(id); }
  list(): InterventionRequest[] {
    return [...this.items.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  update(id: string, patch: Partial<InterventionRequest>): InterventionRequest {
    const cur = this.items.get(id);
    if (!cur) throw new Error(`no such intervention ${id}`);
    const next = { ...cur, ...patch };
    this.items.set(id, next);
    this.persist(next);
    for (const w of this.watchers) w(next);
    return next;
  }

  onChange(cb: (i: InterventionRequest) => void): () => void {
    this.watchers.push(cb);
    return () => { this.watchers = this.watchers.filter((w) => w !== cb); };
  }

  private persist(req: InterventionRequest): void {
    writeFileSync(join(this.dir, `${req.id}.json`), JSON.stringify(req, null, 2), 'utf8');
  }
}
