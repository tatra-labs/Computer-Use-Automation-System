/**
 * The replay result contract — what an AI agent actually gets back.
 *
 * The four statuses are the whole point of the design:
 *   success           — the flow completed and the success condition held
 *   business_outcome  — the app gave a legitimate answer that isn't success
 *                       ("no such member", "not authorized for that branch").
 *                       The caller must handle it; it is NOT an error.
 *   escalated         — the run stopped and a human was asked to take over
 *   failure           — the automation could not proceed; debuggable detail
 */

export type FailureCode =
  | 'INPUT_INVALID'          // caller-supplied args failed the declared contract
  | 'POLICY_DENIED'          // guardrail refused the action or the locus
  | 'APPROVAL_REQUIRED'      // draft capability invoked unattended
  | 'CONFIRMATION_REQUIRED'  // risky step without explicit confirmation
  | 'TARGET_NOT_FOUND'       // no control scored above the acceptance floor
  | 'AMBIGUOUS_TARGET'       // two candidates too close to choose safely
  | 'CHECKPOINT_FAILED'      // action ran, expected state never arrived
  | 'SUCCESS_CONDITION_FAILED'
  | 'OUTPUT_MISSING'         // required declared output could not be extracted
  | 'DIALOG_UNANSWERED'      // modal blocking the surface, no rule for it
  | 'APP_FAULT'              // named hard fault from the app (500 page, etc.)
  | 'RECOVERY_EXHAUSTED'     // recoverable condition kept recurring
  | 'TIMEOUT'                // capability-level duration budget exceeded
  | 'CONTROL_LOST'           // the session's control lease was taken away
  | 'SURFACE_ERROR';         // browser/driver level failure

export type StepStatus = 'ok' | 'skipped' | 'failed' | 'recovered';

export interface StepRecord {
  stepId: string;
  intent: string;
  action: string;
  target?: string;
  status: StepStatus;
  attempts: number;
  durationMs: number;
  /** Resolver confidence and runner-up margin — the audit trail for locators. */
  match?: { score: number; runnerUp?: number };
  checkpoint?: { ok: boolean; detail: string };
  note?: string;
}

export interface RecoveryRecord { code: string; attempt: number; ok: boolean; detail: string }

export type OutputValues = Record<string, string | number | boolean | null>;

export interface ReplayResult {
  runId: string;
  capability: { id: string; name: string; version: number };
  tenant: string | null;
  status: 'success' | 'business_outcome' | 'escalated' | 'failure';
  outputs: OutputValues;
  outcome?: { code: string; message: string };
  failure?: {
    code: FailureCode;
    message: string;
    stepId?: string;
    expected?: string;
    observed?: string;
  };
  escalation?: {
    interventionId: string;
    reason: string;
    stepId?: string;
    resolvedBy?: string;
    resumed: boolean;
  };
  steps: StepRecord[];
  recoveries: RecoveryRecord[];
  /** Structural drift between recording and this run. Warning, not failure. */
  drift?: { expected?: string; observed: string; changed: boolean };
  timing: { startedAt: string; endedAt: string; durationMs: number };
  evidence: { dir: string; journal: string; screenshots: string[]; failureSnapshot?: string };
}

export const isSuccess = (r: ReplayResult): boolean => r.status === 'success';

/** One-line summary for CLI output and logs. */
export function summarize(r: ReplayResult): string {
  switch (r.status) {
    case 'success':
      return `SUCCESS ${r.capability.name}@v${r.capability.version} → ${JSON.stringify(r.outputs)}`;
    case 'business_outcome':
      return `OUTCOME[${r.outcome?.code}] ${r.outcome?.message}`;
    case 'escalated':
      return `ESCALATED intervention=${r.escalation?.interventionId} reason=${r.escalation?.reason}`;
    case 'failure':
      return `FAILURE[${r.failure?.code}] step=${r.failure?.stepId ?? '-'} ${r.failure?.message}`;
  }
}
