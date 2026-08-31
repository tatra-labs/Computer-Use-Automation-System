/**
 * Loading, validating, and specializing artifacts.
 *
 * Multi-tenant reuse lives here. A capability is recorded once against a base
 * configuration of a vendor product; a tenant overlay specializes it. Two levels
 * of specialization, cheapest first:
 *
 *   1. `labelSynonyms` — add this tenant's caption for a control to every
 *      descriptor that names the base caption. No structural change, so one
 *      overlay line covers a rename across the whole flow.
 *   2. per-step patches — surgical, for when the flow itself differs.
 *
 * Anything that cannot be expressed as an overlay is a signal that the tenant is
 * running a materially different flow and deserves its own recording.
 */
import { readFileSync } from 'node:fs';
import {
  AppProfile, Capability, Step, TenantOverlay,
  zAppProfile, zCapability, zTenantOverlay,
} from './artifact.js';
import type { Predicate } from './predicate.js';
import { norm } from './resolve.js';
import type { TargetDescriptor } from './target.js';
import type { ParamValues } from './predicate.js';

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

export const loadCapability = (p: string): Capability => zCapability.parse(readJson(p));
export const loadProfile = (p: string): AppProfile => zAppProfile.parse(readJson(p));
export const loadOverlay = (p: string): TenantOverlay => zTenantOverlay.parse(readJson(p));

// ---------------------------------------------------------------------------
// Descriptor traversal — descriptors hide inside actions, checkpoints, rules
// and output sources, so specialization needs one generic walker.
// ---------------------------------------------------------------------------

type TargetFn = (t: TargetDescriptor) => TargetDescriptor;

function mapPredicate(p: Predicate, fn: TargetFn): Predicate {
  switch (p.kind) {
    case 'controlPresent':
    case 'controlAbsent':
    case 'controlValueMatches':
      return { ...p, target: fn(p.target) };
    case 'all':
    case 'any':
      return { ...p, of: p.of.map((q) => mapPredicate(q, fn)) };
    case 'not':
      return { ...p, of: mapPredicate(p.of, fn) };
    default:
      return p;
  }
}

function mapStep(s: Step, fn: TargetFn): Step {
  const action = 'target' in s.action ? { ...s.action, target: fn(s.action.target) } : s.action;
  const withPred = action.kind === 'waitFor' || action.kind === 'assert'
    ? { ...action, predicate: mapPredicate(action.predicate, fn) }
    : action;
  return {
    ...s,
    action: withPred as Step['action'],
    checkpoint: s.checkpoint ? mapPredicate(s.checkpoint, fn) : undefined,
  };
}

export function mapCapabilityTargets(cap: Capability, fn: TargetFn): Capability {
  return {
    ...cap,
    steps: cap.steps.map((s) => mapStep(s, fn)),
    successCondition: mapPredicate(cap.successCondition, fn),
    outcomes: cap.outcomes.map((o) => ({ ...o, when: mapPredicate(o.when, fn) })),
    faults: cap.faults.map((f) => ({ ...f, when: mapPredicate(f.when, fn) })),
    recovery: cap.recovery.map((r) => ({
      ...r,
      when: mapPredicate(r.when, fn),
      actions: r.actions.map((s) => mapStep(s, fn)),
    })),
    contract: {
      ...cap.contract,
      outputs: cap.contract.outputs.map((o) =>
        'target' in o.source ? { ...o, source: { ...o.source, target: fn(o.source.target) } } : o,
      ),
    },
  };
}

export function mapProfileTargets(profile: AppProfile, fn: TargetFn): AppProfile {
  return {
    ...profile,
    recovery: profile.recovery.map((r) => ({
      ...r, when: mapPredicate(r.when, fn), actions: r.actions.map((s) => mapStep(s, fn)),
    })),
    faults: profile.faults.map((f) => ({ ...f, when: mapPredicate(f.when, fn) })),
    outcomes: profile.outcomes.map((o) => ({ ...o, when: mapPredicate(o.when, fn) })),
    auth: profile.auth
      ? { detect: mapPredicate(profile.auth.detect, fn), steps: profile.auth.steps.map((s) => mapStep(s, fn)) }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Overlay application
// ---------------------------------------------------------------------------

function synonymInjector(labelSynonyms: Record<string, string[]>): TargetFn {
  const index = new Map<string, string[]>();
  for (const [k, v] of Object.entries(labelSynonyms)) index.set(norm(k), v);
  if (index.size === 0) return (t) => t;

  return (t) => {
    let next = t;
    if (t.name) {
      const extra = index.get(norm(t.name.value));
      if (extra) {
        const merged = [...new Set([...t.name.alternatives, ...extra])];
        next = { ...next, name: { ...t.name, alternatives: merged } };
      }
    }
    // Corroborating labels get the same treatment: a renamed column header must
    // not silently break a grid-cell locator.
    if (t.labels.length > 0) {
      const labels = t.labels.flatMap((l) => [l, ...(index.get(norm(l)) ?? [])]);
      if (labels.length !== t.labels.length) next = { ...next, labels: [...new Set(labels)] };
    }
    return next;
  };
}

export interface Specialized {
  capability: Capability;
  profile?: AppProfile;
  tenant: string | null;
  notes: string[];
}

export function specialize(
  capability: Capability,
  profile: AppProfile | undefined,
  overlay: TenantOverlay | undefined,
): Specialized {
  if (!overlay) return { capability, profile, tenant: null, notes: [] };

  const notes: string[] = [];
  if (overlay.productId !== capability.app.productId) {
    throw new Error(
      `overlay is for product "${overlay.productId}" but capability targets "${capability.app.productId}"`,
    );
  }

  const inject = synonymInjector(overlay.labelSynonyms);
  let cap = mapCapabilityTargets(capability, inject);
  const prof = profile ? mapProfileTargets(profile, inject) : undefined;
  if (Object.keys(overlay.labelSynonyms).length > 0) {
    notes.push(`applied ${Object.keys(overlay.labelSynonyms).length} label synonym group(s)`);
  }

  cap = {
    ...cap,
    app: {
      ...cap.app,
      variant: overlay.variant,
      entry: overlay.app?.entry ?? cap.app.entry,
    },
  };
  if (overlay.app?.entry) notes.push(`entry overridden to ${overlay.app.entry}`);

  const patch = overlay.capabilities[capability.id];
  if (patch) {
    const byId = new Map(cap.steps.map((s) => [s.id, s]));
    for (const [stepId, sp] of Object.entries(patch.steps)) {
      const base = byId.get(stepId);
      if (!base) throw new Error(`overlay patches unknown step "${stepId}" of ${capability.id}`);
      const merged: Step = {
        ...base,
        ...(sp.intent !== undefined ? { intent: sp.intent } : {}),
        ...(sp.risk !== undefined ? { risk: sp.risk } : {}),
        ...(sp.timeoutMs !== undefined ? { timeoutMs: sp.timeoutMs } : {}),
        ...(sp.retries !== undefined ? { retries: sp.retries } : {}),
        ...(sp.optional !== undefined ? { optional: sp.optional } : {}),
        ...(sp.checkpoint !== undefined ? { checkpoint: sp.checkpoint } : {}),
        ...(sp.action !== undefined ? { action: sp.action as Step['action'] } : {}),
      };
      byId.set(stepId, merged);
      notes.push(`patched step ${stepId}`);
    }
    cap = { ...cap, steps: cap.steps.map((s) => byId.get(s.id) ?? s) };

    if (patch.extraRecovery.length > 0) {
      cap = { ...cap, recovery: [...cap.recovery, ...patch.extraRecovery.map((r) => mapStepsIn(r, inject))] };
      notes.push(`added ${patch.extraRecovery.length} tenant recovery rule(s)`);
    }
    if (patch.successCondition) {
      cap = { ...cap, successCondition: mapPredicate(patch.successCondition, inject) };
      notes.push('overrode success condition');
    }
  }

  return { capability: cap, profile: prof, tenant: overlay.tenant, notes };
}

function mapStepsIn<T extends { when: Predicate; actions: Step[] }>(rule: T, fn: TargetFn): T {
  return { ...rule, when: mapPredicate(rule.when, fn), actions: rule.actions.map((s) => mapStep(s, fn)) };
}

// ---------------------------------------------------------------------------
// Input validation — reject a bad call before launching a browser
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { ok: true; values: ParamValues }
  | { ok: false; errors: string[] };

export function validateInputs(cap: Capability, raw: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  const values: ParamValues = {};
  const declared = new Set(cap.contract.inputs.map((i) => i.name));

  for (const key of Object.keys(raw)) {
    if (!declared.has(key)) errors.push(`unknown input "${key}"`);
  }

  for (const spec of cap.contract.inputs) {
    const v = raw[spec.name];
    if (v === undefined || v === null || v === '') {
      if (spec.required) errors.push(`missing required input "${spec.name}"`);
      continue;
    }
    const s = String(v);
    if (spec.pattern && !new RegExp(spec.pattern).test(s)) {
      // The value itself is never echoed: it may be regulated data.
      errors.push(`input "${spec.name}" does not match required pattern ${spec.pattern}`);
      continue;
    }
    switch (spec.type) {
      case 'integer': {
        if (!/^-?\d+$/.test(s)) { errors.push(`input "${spec.name}" must be an integer`); continue; }
        values[spec.name] = s; // kept as string: it is typed into a UI field verbatim
        break;
      }
      case 'number':
      case 'money': {
        if (!/^-?\d+(\.\d+)?$/.test(s.replace(/,/g, ''))) { errors.push(`input "${spec.name}" must be numeric`); continue; }
        values[spec.name] = s;
        break;
      }
      case 'boolean': {
        values[spec.name] = /^(1|true|yes|y)$/i.test(s);
        break;
      }
      default:
        values[spec.name] = s;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}
