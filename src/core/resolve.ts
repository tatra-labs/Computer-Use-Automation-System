/**
 * Deterministic target resolution.
 *
 * Pure function of (Observation, TargetDescriptor) → decision. No I/O, no model,
 * no surface knowledge. Both the discovery loop and the replay engine go through
 * it, so a descriptor that resolved during recording resolves identically on
 * replay, and a near-tie is reported rather than guessed.
 */
import { Control, Observation, Role, TargetDescriptor } from './target.js';

export interface Scored {
  control: Control;
  score: number;
  why: string[];
  /** Matched the descriptor's primary caption rather than a tenant synonym. */
  primary: boolean;
}
export type Resolution =
  | { status: 'resolved'; control: Control; score: number; runnerUp?: number; why: string[] }
  | { status: 'not_found'; best?: Scored; considered: number }
  | { status: 'ambiguous'; candidates: Scored[] };

export const norm = (s: string): string =>
  s.replace(/[\s ]+/g, ' ').replace(/[:*]+\s*$/, '').trim().toUpperCase();

const tokens = (s: string): string[] => norm(s).split(/[^A-Z0-9]+/).filter((t) => t.length > 0);

/** Roles that may legitimately stand in for one another across surfaces/markup. */
const ROLE_COMPAT: Partial<Record<Role, Role[]>> = {
  button: ['link', 'menuitem'],
  link: ['button', 'menuitem'],
  textbox: ['password', 'combobox'],
  password: ['textbox'],
  combobox: ['textbox'],
  text: ['cell', 'heading', 'alert'],
  cell: ['text'],
  alert: ['text', 'cell'],
};

function roleScore(want: Role, got: Role): number {
  if (want === got) return 1;
  if (want === 'unknown') return 0.7;
  return ROLE_COMPAT[want]?.includes(got) ? 0.6 : 0;
}

/** 0..1 similarity between a wanted caption and one candidate string. */
function textScore(want: string, got: string, mode: 'exact' | 'contains' | 'regex'): number {
  if (!got) return 0;
  const a = norm(want);
  const b = norm(got);
  if (mode === 'regex') {
    try { return new RegExp(want, 'i').test(got) ? 1 : 0; } catch { return 0; }
  }
  if (a === b) return 1;
  if (mode === 'contains') return b.includes(a) ? 0.9 : 0;
  // 'exact' mode still degrades gracefully: a caption may pick up stray chrome.
  if (b.startsWith(a) || b.endsWith(a)) return 0.82;
  if (b.includes(a) || a.includes(b)) return 0.72;
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  return jaccard >= 0.5 ? 0.4 + 0.3 * jaccard : 0;
}

/**
 * A caption constraint that matches nothing is disqualifying. Without this floor
 * a control of the right role but an unrelated caption scores exactly at the
 * default acceptance threshold on the weighted sum alone — i.e. asking for the
 * button labelled INQUIRE would accept the one labelled SIGN OFF.
 */
const NAME_FLOOR = 0.35;

/** Best score of `want` against the control's accessible name and inferred captions. */
function nameScore(d: TargetDescriptor, c: Control): { s: number; why: string; primary: boolean } {
  if (!d.name) return { s: 0.5, why: 'no-name-constraint', primary: true };
  const mode = d.name.mode;
  const haystacks: Array<[string, number, string]> = [
    [c.name, 1.0, 'accName'],
    ...c.labels.map((l, i) => [l, 1.0 - i * 0.06, `label[${i}]`] as [string, number, string]),
    [c.value ?? '', 0.7, 'value'],
    [c.description ?? '', 0.7, 'desc'],
  ];
  let best = 0;
  let why = 'name:none';
  let primary = false;
  for (const [text, decay, src] of haystacks) {
    const s = textScore(d.name.value, text, mode) * decay;
    if (s > best) { best = s; why = `name:${src}=${s.toFixed(2)}`; primary = true; }
  }
  // Synonyms score just below the primary caption, and `primary` is carried
  // through so a head-to-head between the two is broken by preference rather
  // than by a hairline score difference.
  for (const alt of d.name.alternatives) {
    for (const [text, decay, src] of haystacks) {
      const s = textScore(alt, text, mode) * decay * 0.92;
      if (s > best) { best = s; why = `alt("${alt}"):${src}=${s.toFixed(2)}`; primary = false; }
    }
  }
  return { s: best, why, primary };
}

/** Fraction of wanted captions corroborated by the control's labels/container. */
function corroboration(want: string[], c: Control): number {
  if (want.length === 0) return 1;
  const pool = [...c.labels, ...c.container, c.name];
  let hit = 0;
  for (const w of want) {
    if (pool.some((p) => textScore(w, p, 'exact') >= 0.7)) hit++;
  }
  return hit / want.length;
}

function pathScore(want: string[], got: string[]): number {
  if (want.length === 0) return 1;
  let hit = 0;
  for (const w of want) if (got.some((g) => textScore(w, g, 'exact') >= 0.7)) hit++;
  return hit / want.length;
}

const W = { role: 0.18, name: 0.42, labels: 0.14, frame: 0.12, container: 0.08, hint: 0.06 };

export function scoreControl(d: TargetDescriptor, c: Control): Scored {
  const why: string[] = [];
  const r = roleScore(d.role, c.role);
  if (r === 0) return { control: c, score: 0, why: [`role:${c.role}!=${d.role}`], primary: false };
  why.push(`role=${r.toFixed(2)}`);

  const n = nameScore(d, c);
  why.push(n.why);
  if (d.name && n.s < NAME_FLOOR) {
    return { control: c, score: 0, why: [...why, `caption below floor ${NAME_FLOOR}`], primary: false };
  }
  const lab = corroboration(d.labels, c);
  const fr = pathScore(d.frame, c.frame);
  const cont = pathScore(d.container, c.container);

  let hint = 0.5;
  if (d.hint?.attrName) hint = d.hint.attrName === c.hint?.attrName ? 1 : 0.2;
  if (d.hint?.type && c.hint?.type) hint = (hint + (d.hint.type === c.hint.type ? 1 : 0.2)) / 2;

  let score = W.role * r + W.name * n.s + W.labels * lab + W.frame * fr + W.container * cont + W.hint * hint;

  // Missing corroboration is disqualifying, not a rounding error: a wanted
  // caption that is nowhere to be found usually means the wrong screen, or the
  // wrong row of the right grid. Graded so partial corroboration is penalised
  // proportionally and full corroboration is untouched.
  if (d.labels.length > 0) score *= 0.35 + 0.65 * lab;
  if (d.frame.length > 0) score *= 0.4 + 0.6 * fr;
  if (!c.enabled) score *= 0.75;

  why.push(`labels=${lab.toFixed(2)}`, `frame=${fr.toFixed(2)}`, `container=${cont.toFixed(2)}`);
  return { control: c, score, why, primary: n.primary };
}

/** Total, stable ordering so equal scores never resolve differently run to run. */
function compare(a: Scored, b: Scored): number {
  if (b.score !== a.score) return b.score - a.score;
  const fa = a.control.frame.join('/'), fb = b.control.frame.join('/');
  if (fa !== fb) return fa < fb ? -1 : 1;
  if (a.control.ordinal !== b.control.ordinal) return a.control.ordinal - b.control.ordinal;
  if (a.control.bbox.y !== b.control.bbox.y) return a.control.bbox.y - b.control.bbox.y;
  if (a.control.bbox.x !== b.control.bbox.x) return a.control.bbox.x - b.control.bbox.x;
  return a.control.ref < b.control.ref ? -1 : 1;
}

export function resolveTarget(obs: Observation, d: TargetDescriptor): Resolution {
  const scored = obs.controls.map((c) => scoreControl(d, c)).filter((s) => s.score > 0).sort(compare);
  if (scored.length === 0) return { status: 'not_found', considered: obs.controls.length };

  // An explicit ordinal selects among candidates that already pass the floor —
  // it disambiguates repeated identical controls (grid rows) rather than
  // rescuing a weak match.
  if (d.ordinal !== undefined) {
    const passing = scored.filter((s) => s.score >= d.minScore);
    const pick = passing[d.ordinal];
    if (pick) return { status: 'resolved', control: pick.control, score: pick.score, why: [...pick.why, `ordinal=${d.ordinal}`] };
    return { status: 'not_found', best: scored[0], considered: obs.controls.length };
  }

  const top = scored[0]!;
  if (top.score < d.minScore) return { status: 'not_found', best: top, considered: obs.controls.length };
  const second = scored[1];
  if (second && top.score - second.score < d.minMargin) {
    // A near-tie between a primary caption and a tenant synonym is not genuine
    // ambiguity: the same descriptor is describing one control under two names.
    const primaries = scored.filter((s) => s.score >= d.minScore && s.primary);
    if (primaries.length === 1) {
      const pick = primaries[0]!;
      return { status: 'resolved', control: pick.control, score: pick.score, runnerUp: second.score, why: [...pick.why, 'primary-caption tie-break'] };
    }
    return { status: 'ambiguous', candidates: scored.slice(0, 4) };
  }
  return { status: 'resolved', control: top.control, score: top.score, runnerUp: second?.score, why: top.why };
}

/** Compact description of a descriptor, for logs and failure reports. */
export function describeTarget(d: TargetDescriptor): string {
  const parts: string[] = [d.role];
  if (d.name) parts.push(`${d.name.mode}("${d.name.value}")`);
  if (d.labels.length) parts.push(`labels[${d.labels.join('|')}]`);
  if (d.frame.length) parts.push(`frame[${d.frame.join('/')}]`);
  if (d.ordinal !== undefined) parts.push(`#${d.ordinal}`);
  return parts.join(' ');
}
