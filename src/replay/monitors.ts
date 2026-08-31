/**
 * State classification — the error taxonomy in executable form.
 *
 * After every observation the engine asks one question: "is this screen one of
 * the states we know about?" The answer is drawn from three ordered rule lists,
 * and the order encodes real precedence:
 *
 *   faults    first — an application error page must not be misread as a
 *                     business answer ("no records" on a crashed screen).
 *   recovery  next  — a session-expiry or maintenance interstitial must be
 *                     cleared before we believe anything we can see.
 *   outcomes  last  — with the screen trustworthy, a business result stands.
 *
 * Within each list, capability-specific rules are consulted before the
 * product-wide profile rules, so a capability can sharpen or pre-empt a generic
 * detector without editing the shared profile.
 */
import type { AppProfile, Capability, FaultRule, OutcomeRule, RecoveryRule } from '../core/artifact.js';
import { evaluate, ParamValues } from '../core/predicate.js';
import type { Observation } from '../core/target.js';

export interface RuleSet {
  faults: FaultRule[];
  recovery: RecoveryRule[];
  outcomes: OutcomeRule[];
}

export function mergeRules(cap: Pick<Capability, 'faults' | 'recovery' | 'outcomes'>, profile: AppProfile | undefined): RuleSet {
  return {
    faults: [...cap.faults, ...(profile?.faults ?? [])],
    recovery: [...cap.recovery, ...(profile?.recovery ?? [])],
    outcomes: [...cap.outcomes, ...(profile?.outcomes ?? [])],
  };
}

export type Classification =
  | { kind: 'none' }
  | { kind: 'fault'; rule: FaultRule; detail: string }
  | { kind: 'recovery'; rule: RecoveryRule; detail: string }
  | { kind: 'outcome'; rule: OutcomeRule; detail: string };

export interface ClassifyContext {
  params: ParamValues;
  /** The step about to run (or just run) — for `scope.atSteps`. */
  stepId?: string;
  /** Steps already completed — for `scope.afterStep`. */
  completed: Set<string>;
}

function inScope(scope: { afterStep?: string; atSteps: string[] }, ctx: ClassifyContext): boolean {
  if (scope.atSteps.length > 0 && (!ctx.stepId || !scope.atSteps.includes(ctx.stepId))) return false;
  if (scope.afterStep && !ctx.completed.has(scope.afterStep)) return false;
  return true;
}

export function classify(obs: Observation, rules: RuleSet, ctx: ClassifyContext): Classification {
  for (const rule of rules.faults) {
    if (!inScope(rule.scope, ctx)) continue;
    const r = evaluate(rule.when, obs, ctx.params);
    if (r.ok) return { kind: 'fault', rule, detail: r.detail };
  }
  for (const rule of rules.recovery) {
    if (!inScope(rule.scope, ctx)) continue;
    const r = evaluate(rule.when, obs, ctx.params);
    if (r.ok) return { kind: 'recovery', rule, detail: r.detail };
  }
  for (const rule of rules.outcomes) {
    if (!inScope(rule.scope, ctx)) continue;
    const r = evaluate(rule.when, obs, ctx.params);
    if (r.ok) return { kind: 'outcome', rule, detail: r.detail };
  }
  return { kind: 'none' };
}

/**
 * A recoverable condition that keeps recurring is no longer recoverable. Tracked
 * per rule code so clearing an interstitial twice is fine while an unbreakable
 * redirect loop terminates.
 */
export class RecoveryLedger {
  private counts = new Map<string, number>();

  attempt(code: string): number {
    const n = (this.counts.get(code) ?? 0) + 1;
    this.counts.set(code, n);
    return n;
  }

  exhausted(rule: RecoveryRule): boolean {
    return (this.counts.get(rule.code) ?? 0) >= rule.maxAttempts;
  }

  get summary(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}
