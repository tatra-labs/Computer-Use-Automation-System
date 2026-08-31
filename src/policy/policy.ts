/**
 * The guardrail. Every surface action in the system — discovery and replay
 * alike — passes through one PolicyGate instance. A single choke point is the
 * whole design: there is exactly one place to read to know what the automation
 * is permitted to do, and no code path that can act without asking.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Risk } from '../core/artifact.js';

export const zPolicy = z.object({
  version: z.number().int(),
  allowlist: z.object({
    /** Regexes a locus (URL / window identity) must match to be touched at all. */
    loci: z.array(z.string()).min(1),
    /** Action kinds the automation may perform. Anything absent is denied. */
    actions: z.array(z.enum([
      'navigate', 'click', 'type', 'select', 'press', 'dialog', 'waitFor', 'assert', 'extract', 'observe', 'screenshot',
    ])).min(1),
  }),
  /**
   * What to do with each risk class.
   *  allow   — proceed
   *  confirm — proceed only with an explicit per-invocation confirmation, or a
   *            human decision obtained through escalation
   *  block   — never
   */
  risk: z.object({
    read: z.enum(['allow', 'confirm', 'block']).default('allow'),
    write: z.enum(['allow', 'confirm', 'block']).default('allow'),
    irreversible: z.enum(['allow', 'confirm', 'block']).default('confirm'),
  }),
  limits: z.object({
    maxSteps: z.number().int().positive().default(40),
    maxDurationMs: z.number().int().positive().default(180_000),
    maxLlmCalls: z.number().int().positive().default(30),
    maxNavigations: z.number().int().positive().default(25),
  }),
  unattended: z.object({
    /** Refuse unattended replay of a draft capability. */
    requireApproved: z.boolean().default(true),
    /** Refuse unattended replay below this observed success rate. */
    minSuccessRate: z.number().min(0).max(1).default(0),
  }).default({ requireApproved: true, minSuccessRate: 0 }),
  redaction: z.object({
    extraPatterns: z.array(z.string()).default([]),
  }).default({ extraPatterns: [] }),
});
export type Policy = z.infer<typeof zPolicy>;

export type ActionKind = Policy['allowlist']['actions'][number];

export type Decision =
  | { allow: true; requiresConfirmation?: false }
  | { allow: true; requiresConfirmation: true; reason: string }
  | { allow: false; reason: string };

export interface ActionContext {
  kind: ActionKind;
  risk: Risk;
  /** Locus the action targets (for navigate) or the current locus. */
  locus: string;
  /** The caller explicitly authorized risky work for this invocation. */
  confirmed: boolean;
  /** A human already approved this specific step via escalation. */
  humanApproved?: boolean;
}

export class PolicyViolation extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'PolicyViolation'; }
}

export class PolicyGate {
  private locusRes: RegExp[];
  private navigations = 0;
  private llmCalls = 0;
  private steps = 0;
  private readonly startedAt = Date.now();

  constructor(readonly policy: Policy) {
    this.locusRes = policy.allowlist.loci.map((p) => new RegExp(p));
  }

  static fromFile(path: string): PolicyGate {
    return new PolicyGate(zPolicy.parse(JSON.parse(readFileSync(path, 'utf8'))));
  }

  locusAllowed(locus: string): boolean {
    return this.locusRes.some((re) => re.test(locus));
  }

  /** The one function every action goes through. */
  check(ctx: ActionContext): Decision {
    if (!this.policy.allowlist.actions.includes(ctx.kind)) {
      return { allow: false, reason: `action kind "${ctx.kind}" is not in the allowlist` };
    }
    if (!this.locusAllowed(ctx.locus)) {
      return { allow: false, reason: `locus "${ctx.locus}" is outside the allowlist` };
    }
    const disposition = this.policy.risk[ctx.risk];
    if (disposition === 'block') {
      return { allow: false, reason: `risk class "${ctx.risk}" is blocked by policy` };
    }
    if (disposition === 'confirm' && !ctx.confirmed && !ctx.humanApproved) {
      return { allow: true, requiresConfirmation: true, reason: `risk class "${ctx.risk}" requires confirmation` };
    }
    return { allow: true };
  }

  /** Budget accounting. Exceeding a budget is a stop condition, not a warning. */
  countNavigation(): Decision {
    if (++this.navigations > this.policy.limits.maxNavigations) {
      return { allow: false, reason: `navigation budget exhausted (${this.policy.limits.maxNavigations})` };
    }
    return { allow: true };
  }

  countStep(): Decision {
    if (++this.steps > this.policy.limits.maxSteps) {
      return { allow: false, reason: `step budget exhausted (${this.policy.limits.maxSteps})` };
    }
    return { allow: true };
  }

  countLlmCall(): Decision {
    if (++this.llmCalls > this.policy.limits.maxLlmCalls) {
      return { allow: false, reason: `LLM call budget exhausted (${this.policy.limits.maxLlmCalls})` };
    }
    return { allow: true };
  }

  timeLeftMs(): number {
    return this.policy.limits.maxDurationMs - (Date.now() - this.startedAt);
  }

  expired(): boolean {
    return this.timeLeftMs() <= 0;
  }

  /**
   * Gate on the capability itself, before a browser is launched: approval state,
   * observed stability, and whether the flow contains risk the caller has not
   * authorized.
   */
  checkInvocation(cap: {
    approval: { state: string };
    stability: { replays: number; successRate?: number | undefined };
    policy: { allowUnattended: boolean; requiresConfirmation: Risk[] };
    steps: Array<{ risk: Risk }>;
  }, opts: { unattended: boolean; confirmed: boolean }): Decision {
    if (opts.unattended) {
      if (this.policy.unattended.requireApproved && cap.approval.state !== 'approved') {
        return { allow: false, reason: `unattended replay requires approval state "approved" (is "${cap.approval.state}")` };
      }
      if (!cap.policy.allowUnattended) {
        return { allow: false, reason: 'capability is not marked allowUnattended' };
      }
      const min = this.policy.unattended.minSuccessRate;
      if (min > 0 && (cap.stability.successRate ?? 0) < min) {
        return { allow: false, reason: `observed success rate ${cap.stability.successRate ?? 0} below required ${min}` };
      }
    }
    const risky = cap.steps.filter((s) => cap.policy.requiresConfirmation.includes(s.risk));
    if (risky.length > 0 && !opts.confirmed) {
      return {
        allow: true,
        requiresConfirmation: true,
        reason: `${risky.length} step(s) of class [${[...new Set(risky.map((s) => s.risk))].join(',')}] require confirmation`,
      };
    }
    return { allow: true };
  }
}
