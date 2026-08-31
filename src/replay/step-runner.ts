/**
 * A minimal deterministic step executor, used to run *profile* sub-flows (sign-on,
 * clearing a maintenance notice) outside the replay engine — during discovery, and
 * anywhere a known state must be cleared before a model is consulted.
 *
 * The replay engine has the full-fidelity executor (classification, bounded
 * retries, escalation, evidence). This one exists so discovery does not have to
 * ask a model how to sign on: authentication is never discovered and never
 * recorded, it is a property of the application profile.
 */
import type { Step } from '../core/artifact.js';
import { evaluate, interpolate, interpolateTarget, ParamValues } from '../core/predicate.js';
import { describeTarget, resolveTarget } from '../core/resolve.js';
import type { Session } from '../session/session.js';

export type SubflowResult = { ok: true } | { ok: false; stepId: string; reason: string };

export async function runSubflow(session: Session, steps: Step[], params: ParamValues): Promise<SubflowResult> {
  for (const step of steps) {
    const r = await runOne(session, step, params);
    if (!r.ok) return r;
  }
  return { ok: true };
}

async function runOne(session: Session, step: Step, params: ParamValues): Promise<SubflowResult> {
  const a = step.action;

  if (a.kind === 'waitFor' || a.kind === 'assert') {
    const ok = await poll(session, a.predicate, params, step.timeoutMs);
    return ok ? { ok: true } : { ok: false, stepId: step.id, reason: `predicate never held (${step.timeoutMs}ms)` };
  }
  if (a.kind === 'extract') {
    return { ok: false, stepId: step.id, reason: 'extract is not valid in a profile sub-flow' };
  }

  let ref: string | undefined;
  if ('target' in a) {
    const target = interpolateTarget(a.target, params);
    const deadline = Date.now() + step.timeoutMs;
    for (;;) {
      const obs = await session.surface.observe();
      const res = resolveTarget(obs, target);
      if (res.status === 'resolved') { ref = res.control.ref; break; }
      if (res.status === 'ambiguous' || Date.now() >= deadline) {
        if (step.optional) return { ok: true };
        return { ok: false, stepId: step.id, reason: `target ${res.status}: ${describeTarget(target)}` };
      }
      await sleep(150);
    }
  }

  const text = a.kind === 'type'
    ? (a.text.kind === 'secretRef' ? process.env[a.text.env] : a.text.kind === 'param' ? String(params[a.text.param] ?? '') : interpolate(a.text.value, params))
    : undefined;
  if (a.kind === 'type' && a.text.kind === 'secretRef') {
    if (!text) return { ok: false, stepId: step.id, reason: `secret env var ${a.text.env} is not set` };
    session.redactor.registerValue(text, 'secret');
  }

  const outcome = await session.act({
    kind: a.kind === 'dialog' ? 'dialog' : a.kind,
    risk: step.risk,
    stepId: step.id,
    describe: step.intent,
    ref,
    text,
    locus: a.kind === 'navigate' ? interpolate(a.locus, params) : undefined,
    key: a.kind === 'press' ? a.key : undefined,
    value: a.kind === 'select' ? (a.value.kind === 'literal' ? interpolate(a.value.value, params) : String(params[(a.value as { param: string }).param] ?? '')) : undefined,
    decision: a.kind === 'dialog' ? a.decision : undefined,
    clearFirst: a.kind === 'type' ? a.clearFirst : undefined,
    pressEnter: a.kind === 'type' ? a.pressEnter : undefined,
    confirmed: true, // profile sub-flows are pre-authorized by configuration
  });
  if (!outcome.ok) return { ok: false, stepId: step.id, reason: `${outcome.code}: ${outcome.reason}` };

  if (step.checkpoint) {
    const ok = await poll(session, step.checkpoint, params, step.timeoutMs);
    if (!ok) return { ok: false, stepId: step.id, reason: `checkpoint never held (${step.timeoutMs}ms)` };
  }
  return { ok: true };
}

async function poll(session: Session, pred: Parameters<typeof evaluate>[0], params: ParamValues, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const obs = await session.surface.observe();
    if (evaluate(pred, obs, params).ok) return true;
    if (Date.now() >= deadline) return false;
    await sleep(150);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
