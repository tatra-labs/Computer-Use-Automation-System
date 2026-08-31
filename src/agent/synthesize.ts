/**
 * Turning "the model clicked this control" into "how the artifact will find it
 * again" — the single most consequential step in the recording, because it
 * decides whether replay still works next month.
 *
 * The strategy is escalating specificity, and every candidate descriptor is
 * *verified to resolve back to the same control* against the very observation it
 * was derived from. A locator that did not work at record time never reaches an
 * artifact.
 *
 * Signals are ordered by how well they survive change:
 *   1. role                        — stable across releases and surfaces
 *   2. accessible name / caption   — what a human reads; renamed rarely, and a
 *                                    rename is exactly what a tenant overlay's
 *                                    synonyms are for
 *   3. corroborating labels        — column header + row label; how you address a
 *                                    cell in a table-based legacy grid
 *   4. frame path                  — coarse, cheap, and framesets are forever
 *   5. container caption           — disambiguates repeated forms on one screen
 *   6. ordinal                     — last resort for genuinely identical controls
 *   7. attrName/type hints         — recorded for diagnosis, weighted near zero,
 *                                    never sufficient alone (generated ids churn)
 */
import { resolveTarget } from '../core/resolve.js';
import type { Control, Observation, TargetDescriptor } from '../core/target.js';

export interface Synthesized {
  descriptor: TargetDescriptor;
  /** Human-readable reasoning, stored on the descriptor as `note`. */
  rationale: string;
  /** Confidence with which this descriptor re-resolved to the same control. */
  score: number;
  /** Signals that had to be added to make it unambiguous. */
  escalations: string[];
}

const BASE = { labels: [] as string[], container: [] as string[], frame: [] as string[], minScore: 0.55, minMargin: 0.08 };

function withName(c: Control, value: string): TargetDescriptor {
  return { ...BASE, role: c.role, name: { value, mode: 'exact', alternatives: [] } };
}

/** Cells hold data; their own text is the value, so the caption must come from labels. */
const isDataCell = (c: Control): boolean => c.role === 'cell' || c.role === 'row';

export function synthesizeDescriptor(control: Control, obs: Observation): Synthesized {
  const escalations: string[] = [];
  const nameSource = !isDataCell(control) && control.name
    ? { value: control.name, why: 'accessible name' }
    : control.labels[0]
      ? { value: control.labels[0], why: 'inferred caption (adjacent cell / column header)' }
      : control.name
        ? { value: control.name, why: 'own text' }
        : undefined;

  let d: TargetDescriptor = nameSource
    ? withName(control, nameSource.value)
    : { ...BASE, role: control.role };

  // A data cell is identified by the labels around it, never by its own value —
  // the value is what changes between runs.
  if (isDataCell(control)) {
    d = { ...BASE, role: control.role, labels: control.labels.slice(0, 3) };
    escalations.push('labels (data cell: identified by row + column captions)');
  }

  const attempts: Array<{ label: string; build: (prev: TargetDescriptor) => TargetDescriptor }> = [
    { label: 'frame path', build: (p) => ({ ...p, frame: control.frame }) },
    {
      label: 'corroborating labels',
      build: (p) => ({
        ...p,
        labels: [...new Set([...p.labels, ...control.labels.filter((l) => l !== p.name?.value).slice(0, 2)])],
      }),
    },
    { label: 'container caption', build: (p) => ({ ...p, container: control.container.slice(0, 1) }) },
    { label: 'field name hint', build: (p) => ({ ...p, hint: { attrName: control.hint?.attrName, type: control.hint?.type } }) },
  ];

  let best = check(obs, d, control);
  for (const a of attempts) {
    if (best.ok && best.unique) break;
    const next = a.build(d);
    const r = check(obs, next, control);
    // Only keep an escalation that actually helped.
    if (r.score > best.score || (r.ok && !best.ok)) {
      d = next;
      best = r;
      escalations.push(a.label);
    }
  }

  // Genuinely identical controls (repeated grid rows) need an index. Determined
  // from the same deterministic ordering replay will use.
  if (!best.ok || !best.unique) {
    const ordinal = ordinalOf(obs, d, control);
    if (ordinal >= 0) {
      d = { ...d, ordinal };
      best = check(obs, d, control);
      escalations.push(`ordinal ${ordinal}`);
    }
  }

  const rationale = [
    nameSource ? `matched on ${nameSource.why} "${nameSource.value}"` : `no caption available; matched structurally`,
    escalations.length ? `disambiguated by ${escalations.join(', ')}` : 'unambiguous on its own',
    best.ok ? `re-resolved to the same control at ${best.score.toFixed(2)}` : `WARNING: did not re-resolve cleanly (${best.status})`,
  ].join('; ');

  return { descriptor: { ...d, note: rationale }, rationale, score: best.score, escalations };
}

function check(obs: Observation, d: TargetDescriptor, want: Control) {
  const r = resolveTarget(obs, d);
  if (r.status === 'resolved') {
    return { ok: r.control.ref === want.ref, unique: true, score: r.control.ref === want.ref ? r.score : 0, status: 'resolved' };
  }
  if (r.status === 'ambiguous') {
    const hit = r.candidates.find((c) => c.control.ref === want.ref);
    return { ok: !!hit, unique: false, score: (hit?.score ?? 0) * 0.5, status: 'ambiguous' };
  }
  return { ok: false, unique: false, score: 0, status: 'not_found' };
}

/** Index of `want` among the candidates that pass the descriptor's floor. */
function ordinalOf(obs: Observation, d: TargetDescriptor, want: Control): number {
  const probe: TargetDescriptor = { ...d, minMargin: 0, ordinal: undefined };
  for (let i = 0; i < 12; i++) {
    const r = resolveTarget(obs, { ...probe, ordinal: i });
    if (r.status !== 'resolved') return -1;
    if (r.control.ref === want.ref) return i;
  }
  return -1;
}
