/**
 * The capability artifact: a typed, versioned, reviewable description of one
 * UI flow, decoupled from the model transcript that discovered it.
 *
 * Three ideas shape the schema:
 *
 *  1. It is a *contract*, not a script. Typed inputs, typed outputs, a success
 *     condition, and a declared error surface — so a calling agent knows what
 *     it needs, what it gets back, and what can legitimately come back instead.
 *  2. The error taxonomy is *structural*, not a severity field. Three separate
 *     rule lists — `outcomes` (expected business results), `recovery`
 *     (recoverable conditions) and `faults` (hard failures) — make it
 *     impossible to conflate "no such member" with "the automation broke".
 *  3. What is shared lives in an AppProfile (per vendor product) and what is
 *     tenant-specific lives in a TenantOverlay. A capability recorded once is
 *     the base; tenants specialize by overlay, never by re-recording.
 */
import { z } from 'zod';
import { zPredicate, type Predicate } from './predicate.js';
import { zTargetDescriptor } from './target.js';

export const SCHEMA_CAPABILITY = 'handspan.capability/v1';
export const SCHEMA_PROFILE = 'handspan.app-profile/v1';
export const SCHEMA_OVERLAY = 'handspan.tenant-overlay/v1';

/** Data classification drives redaction and what may be persisted at all. */
export const zSensitivity = z.enum(['public', 'internal', 'pii', 'secret']);
export type Sensitivity = z.infer<typeof zSensitivity>;

export const zValueType = z.enum(['string', 'integer', 'number', 'boolean', 'money', 'date']);

/**
 * Action risk. `read` observes; `write` mutates but is correctable;
 * `irreversible` posts something a human cannot cleanly undo (a transaction, an
 * account opening). The class is recorded per step so policy can gate it
 * without re-reading the flow.
 */
export const zRisk = z.enum(['read', 'write', 'irreversible']);
export type Risk = z.infer<typeof zRisk>;

export const zInput = z.object({
  name: z.string().regex(/^[a-z][A-Za-z0-9_]*$/),
  type: zValueType,
  required: z.boolean().default(true),
  description: z.string(),
  sensitivity: zSensitivity.default('internal'),
  /** Validated before the browser is even opened — cheap rejection of bad calls. */
  pattern: z.string().optional(),
  example: z.string().optional(),
});
export type CapabilityInput = z.infer<typeof zInput>;

/** Where an output value is read from. Same target vocabulary as actions. */
export const zExtractSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('controlText'), target: zTargetDescriptor }),
  z.object({ kind: z.literal('controlValue'), target: zTargetDescriptor }),
  z.object({ kind: z.literal('pageRegex'), pattern: z.string(), group: z.number().int().default(1) }),
]);

export const zOutput = z.object({
  name: z.string().regex(/^[a-z][A-Za-z0-9_]*$/),
  type: zValueType,
  description: z.string(),
  sensitivity: zSensitivity.default('internal'),
  required: z.boolean().default(true),
  source: zExtractSource,
  /** Applied in order. `money` strips grouping/currency to a bare decimal. */
  transform: z.array(z.enum(['trim', 'upper', 'digits', 'money', 'collapseSpace'])).default([]),
});
export type CapabilityOutput = z.infer<typeof zOutput>;

const zTextSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('param'), param: z.string() }),
  z.object({ kind: z.literal('literal'), value: z.string() }),
  /** Env-var *name* only. Secret values never enter an artifact. */
  z.object({ kind: z.literal('secretRef'), env: z.string() }),
]);

export const zAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), locus: z.string() }),
  z.object({ kind: z.literal('click'), target: zTargetDescriptor }),
  z.object({
    kind: z.literal('type'), target: zTargetDescriptor, text: zTextSource,
    clearFirst: z.boolean().default(true), pressEnter: z.boolean().default(false),
  }),
  z.object({ kind: z.literal('select'), target: zTargetDescriptor, value: zTextSource }),
  z.object({ kind: z.literal('press'), key: z.string() }),
  /** Native modals are first-class state, answered explicitly and never silently. */
  z.object({ kind: z.literal('dialog'), decision: z.enum(['accept', 'dismiss']) }),
  z.object({ kind: z.literal('waitFor'), predicate: zPredicate }),
  z.object({ kind: z.literal('assert'), predicate: zPredicate }),
  /** Capture declared outputs at this point in the flow. */
  z.object({ kind: z.literal('extract'), outputs: z.array(z.string()) }),
]);
export type Action = z.infer<typeof zAction>;

export const zStep = z.object({
  id: z.string().regex(/^s[0-9]+[a-z]?$/),
  /** Plain-language intent, written at discovery time. This is what a reviewer reads. */
  intent: z.string(),
  action: zAction,
  risk: zRisk.default('read'),
  /** Post-condition. A step without one is a step that assumed its click worked. */
  checkpoint: zPredicate.optional(),
  /** Budget for checkpoint satisfaction (polling, not sleeping). */
  timeoutMs: z.number().int().positive().default(8000),
  /** Re-attempts of the whole step when the checkpoint does not hold. */
  retries: z.number().int().min(0).max(3).default(1),
  /** Skip silently when the target is absent — for conditional interstitials. */
  optional: z.boolean().default(false),
});
export type Step = z.infer<typeof zStep>;

/** Restrict a rule to part of the flow, so an early screen can't trip a late detector. */
const zScope = z.object({ afterStep: z.string().optional(), atSteps: z.array(z.string()).default([]) }).default({ atSteps: [] });

/** An expected business result. Terminal, reported as a *result*, never an error. */
export const zOutcomeRule = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  when: zPredicate,
  message: z.string(),
  /** Values still worth returning alongside a non-success outcome. */
  outputs: z.array(z.string()).default([]),
  scope: zScope,
});
export type OutcomeRule = z.infer<typeof zOutcomeRule>;

/** A condition the replay can clear itself, then continue where it left off. */
export const zRecoveryRule = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  when: zPredicate,
  message: z.string(),
  /** Sub-flow to clear the condition. Ordinary steps, ordinary policy checks. */
  actions: z.array(zStep),
  maxAttempts: z.number().int().min(1).max(5).default(2),
  /** Re-run the interrupted step after recovering (vs. just re-observing). */
  retryStepAfter: z.boolean().default(true),
  scope: zScope,
});
export type RecoveryRule = z.infer<typeof zRecoveryRule>;

/** A named hard failure: stop, report, do not retry. */
export const zFaultRule = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  when: zPredicate,
  message: z.string(),
  /** Ask for a human instead of just failing. */
  escalate: z.boolean().default(false),
  scope: zScope,
});
export type FaultRule = z.infer<typeof zFaultRule>;

// ---------------------------------------------------------------------------
// App profile — shared across every capability for one vendor product
// ---------------------------------------------------------------------------

export const zAppProfile = z.object({
  kind: z.literal('app-profile'),
  schemaVersion: z.literal(SCHEMA_PROFILE),
  productId: z.string(),
  title: z.string(),
  surface: z.enum(['web', 'desktop']),
  /** Product-wide states: session expiry, maintenance notices, app error pages. */
  recovery: z.array(zRecoveryRule).default([]),
  faults: z.array(zFaultRule).default([]),
  outcomes: z.array(zOutcomeRule).default([]),
  /** Reusable sign-on sub-flow, referenced by session-expiry recovery. */
  auth: z.object({
    detect: zPredicate,
    steps: z.array(zStep),
  }).optional(),
});
export type AppProfile = z.infer<typeof zAppProfile>;

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

export const zCapability = z.object({
  kind: z.literal('capability'),
  schemaVersion: z.literal(SCHEMA_CAPABILITY),
  id: z.string(),
  /** Callable name an agent uses. Snake case, verb-first. */
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  version: z.number().int().positive(),
  title: z.string(),
  description: z.string(),

  app: z.object({
    productId: z.string(),
    /** Which configuration of the product this was recorded against. */
    variant: z.string().default('base'),
    surface: z.enum(['web', 'desktop']),
    entry: z.string(),
    profile: z.string(),
  }),

  contract: z.object({
    inputs: z.array(zInput),
    outputs: z.array(zOutput),
  }),

  steps: z.array(zStep).min(1),
  /** Asserted before declaring success, independent of per-step checkpoints. */
  successCondition: zPredicate,

  outcomes: z.array(zOutcomeRule).default([]),
  recovery: z.array(zRecoveryRule).default([]),
  faults: z.array(zFaultRule).default([]),

  policy: z.object({
    maxDurationMs: z.number().int().positive().default(120_000),
    /** May an agent invoke this with no human watching? */
    allowUnattended: z.boolean().default(false),
    /** Risk classes that need an explicit per-invocation confirmation. */
    requiresConfirmation: z.array(zRisk).default(['irreversible']),
  }).default({ maxDurationMs: 120_000, allowUnattended: false, requiresConfirmation: ['irreversible'] }),

  provenance: z.object({
    discoveredBy: z.string(),
    plannerProvider: z.string(),
    runId: z.string(),
    discoveredAt: z.string(),
    /** Structural hash of the entry screen when recorded — drift signal. */
    entryFingerprint: z.string().optional(),
    llmSteps: z.number().int().nonnegative().default(0),
    /** Steps a human performed during discovery, if it was escalated. */
    humanAssistedSteps: z.array(z.string()).default([]),
    promptVersion: z.string().default('discovery/v1'),
  }),

  approval: z.object({
    state: z.enum(['draft', 'approved', 'revoked']).default('draft'),
    by: z.string().optional(),
    at: z.string().optional(),
    note: z.string().optional(),
  }).default({ state: 'draft' }),

  stability: z.object({
    replays: z.number().int().nonnegative().default(0),
    successes: z.number().int().nonnegative().default(0),
    lastReplayAt: z.string().optional(),
    /** successes / replays; unattended promotion can gate on it. */
    successRate: z.number().min(0).max(1).optional(),
  }).default({ replays: 0, successes: 0 }),
});
export type Capability = z.infer<typeof zCapability>;

// ---------------------------------------------------------------------------
// Tenant overlay — how one recording serves many institutions
// ---------------------------------------------------------------------------

const zStepPatch = z.object({
  intent: z.string().optional(),
  action: z.unknown().optional(),
  checkpoint: zPredicate.optional(),
  timeoutMs: z.number().int().positive().optional(),
  retries: z.number().int().min(0).max(3).optional(),
  optional: z.boolean().optional(),
  risk: zRisk.optional(),
});

export const zTenantOverlay = z.object({
  kind: z.literal('tenant-overlay'),
  schemaVersion: z.literal(SCHEMA_OVERLAY),
  tenant: z.string(),
  productId: z.string(),
  variant: z.string(),
  app: z.object({ entry: z.string().optional() }).optional(),
  /**
   * Extra captions for the same logical control in this tenant's configuration.
   * Keyed by the base descriptor's primary name. Applied to every descriptor in
   * the capability — the cheapest possible specialization, and usually enough.
   */
  labelSynonyms: z.record(z.array(z.string())).default({}),
  /** Surgical per-step patches when synonyms are not enough. */
  capabilities: z.record(z.object({
    steps: z.record(zStepPatch).default({}),
    extraRecovery: z.array(zRecoveryRule).default([]),
    successCondition: zPredicate.optional(),
  })).default({}),
  note: z.string().optional(),
});
export type TenantOverlay = z.infer<typeof zTenantOverlay>;

export type { Predicate };
