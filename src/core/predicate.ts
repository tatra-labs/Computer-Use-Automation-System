/**
 * Predicates are the single mechanism for *asserting* and *classifying* state:
 * step checkpoints, success conditions, business-outcome detectors and
 * recoverable-condition detectors are all built from them. One evaluator means
 * one place where "how do we know what screen we're on" is defined.
 */
import { z } from 'zod';
import { resolveTarget } from './resolve.js';
import { Observation, zTargetDescriptor } from './target.js';

export type Predicate =
  | { kind: 'controlPresent'; target: z.infer<typeof zTargetDescriptor> }
  | { kind: 'controlAbsent'; target: z.infer<typeof zTargetDescriptor> }
  | { kind: 'controlValueMatches'; target: z.infer<typeof zTargetDescriptor>; pattern: string }
  | { kind: 'textMatches'; pattern: string }
  | { kind: 'textAbsent'; pattern: string }
  | { kind: 'locusMatches'; pattern: string }
  | { kind: 'titleMatches'; pattern: string }
  | { kind: 'dialogPresent'; pattern?: string }
  | { kind: 'all'; of: Predicate[] }
  | { kind: 'any'; of: Predicate[] }
  | { kind: 'not'; of: Predicate };

export const zPredicate: z.ZodType<Predicate> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('controlPresent'), target: zTargetDescriptor }),
    z.object({ kind: z.literal('controlAbsent'), target: zTargetDescriptor }),
    z.object({ kind: z.literal('controlValueMatches'), target: zTargetDescriptor, pattern: z.string() }),
    z.object({ kind: z.literal('textMatches'), pattern: z.string() }),
    z.object({ kind: z.literal('textAbsent'), pattern: z.string() }),
    z.object({ kind: z.literal('locusMatches'), pattern: z.string() }),
    z.object({ kind: z.literal('titleMatches'), pattern: z.string() }),
    z.object({ kind: z.literal('dialogPresent'), pattern: z.string().optional() }),
    z.object({ kind: z.literal('all'), of: z.array(zPredicate) }),
    z.object({ kind: z.literal('any'), of: z.array(zPredicate) }),
    z.object({ kind: z.literal('not'), of: zPredicate }),
  ]) as unknown as z.ZodType<Predicate>,
);

export type ParamValues = Record<string, string | number | boolean>;

/**
 * `{{param}}` interpolation. Used in patterns and in target names so a single
 * recorded flow can assert member-specific state ("RECORD NOT FOUND FOR MBR
 * {{memberId}}") without the recorded value being baked in.
 */
export function interpolate(s: string, params: ParamValues): string {
  return s.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (m, k: string) =>
    k in params ? String(params[k]) : m,
  );
}

/**
 * Interpolates every text surface of a descriptor, not just `name`. Labels and
 * container captions carry `{{param}}` tokens too — the sub-account posting
 * confirmation corroborates its REFERENCE NO cell with the row above it showing
 * "MBR NO: {{memberId}}", and without this that corroboration could only ever be
 * expressed as the raw recorded member number or dropped outright.
 */
export function interpolateTarget(t: z.infer<typeof zTargetDescriptor>, p: ParamValues) {
  return {
    ...t,
    name: t.name
      ? { ...t.name, value: interpolate(t.name.value, p), alternatives: t.name.alternatives.map((a) => interpolate(a, p)) }
      : t.name,
    labels: t.labels.map((l) => interpolate(l, p)),
    container: t.container.map((c) => interpolate(c, p)),
  };
}

export interface PredicateResult { ok: boolean; detail: string }

export function evaluate(pred: Predicate, obs: Observation, params: ParamValues = {}): PredicateResult {
  switch (pred.kind) {
    case 'controlPresent': {
      const r = resolveTarget(obs, interpolateTarget(pred.target, params));
      return { ok: r.status === 'resolved', detail: `controlPresent → ${r.status}` };
    }
    case 'controlAbsent': {
      const r = resolveTarget(obs, interpolateTarget(pred.target, params));
      return { ok: r.status !== 'resolved', detail: `controlAbsent → ${r.status}` };
    }
    case 'controlValueMatches': {
      const r = resolveTarget(obs, interpolateTarget(pred.target, params));
      if (r.status !== 'resolved') return { ok: false, detail: `controlValueMatches → target ${r.status}` };
      const p = interpolate(pred.pattern, params);
      const ok = new RegExp(p).test(r.control.value ?? '');
      return { ok, detail: `control value "${r.control.value ?? ''}" ~ /${p}/ → ${ok}` };
    }
    case 'textMatches': {
      const p = interpolate(pred.pattern, params);
      const ok = new RegExp(p, 'i').test(obs.text);
      return { ok, detail: `text ~ /${p}/i → ${ok}` };
    }
    case 'textAbsent': {
      const p = interpolate(pred.pattern, params);
      const ok = !new RegExp(p, 'i').test(obs.text);
      return { ok, detail: `text !~ /${p}/i → ${ok}` };
    }
    case 'locusMatches': {
      const p = interpolate(pred.pattern, params);
      const ok = new RegExp(p, 'i').test(obs.locus);
      return { ok, detail: `locus ~ /${p}/i → ${ok}` };
    }
    case 'titleMatches': {
      const p = interpolate(pred.pattern, params);
      const ok = new RegExp(p, 'i').test(obs.title);
      return { ok, detail: `title ~ /${p}/i → ${ok}` };
    }
    case 'dialogPresent': {
      if (!obs.pendingDialog) return { ok: false, detail: 'no pending dialog' };
      if (!pred.pattern) return { ok: true, detail: `dialog(${obs.pendingDialog.kind})` };
      const ok = new RegExp(interpolate(pred.pattern, params), 'i').test(obs.pendingDialog.message);
      return { ok, detail: `dialog message ~ /${pred.pattern}/i → ${ok}` };
    }
    case 'all': {
      const rs = pred.of.map((p) => evaluate(p, obs, params));
      const bad = rs.filter((r) => !r.ok);
      return { ok: bad.length === 0, detail: bad.length ? `all: failed [${bad.map((b) => b.detail).join('; ')}]` : 'all: ok' };
    }
    case 'any': {
      const rs = pred.of.map((p) => evaluate(p, obs, params));
      const good = rs.find((r) => r.ok);
      return { ok: !!good, detail: good ? `any: ${good.detail}` : `any: none of [${rs.map((r) => r.detail).join('; ')}]` };
    }
    case 'not': {
      const r = evaluate(pred.of, obs, params);
      return { ok: !r.ok, detail: `not(${r.detail})` };
    }
  }
}

export function describePredicate(p: Predicate): string {
  switch (p.kind) {
    case 'all': return `all(${p.of.map(describePredicate).join(', ')})`;
    case 'any': return `any(${p.of.map(describePredicate).join(', ')})`;
    case 'not': return `not(${describePredicate(p.of)})`;
    case 'controlPresent': return `controlPresent(${p.target.role}:"${p.target.name?.value ?? ''}")`;
    case 'controlAbsent': return `controlAbsent(${p.target.role}:"${p.target.name?.value ?? ''}")`;
    case 'controlValueMatches': return `controlValueMatches(${p.target.role}:"${p.target.name?.value ?? ''}" ~ /${p.pattern}/)`;
    case 'dialogPresent': return `dialogPresent(${p.pattern ?? '*'})`;
    default: return `${p.kind}(${p.pattern})`;
  }
}
