/**
 * Fixture builders for the pure-module tests. Every required field of the
 * perception vocabulary gets a benign default so a test can state only the one
 * property it is actually about.
 */
import { z } from 'zod';
import { Control, Observation, TargetDescriptor, zTargetDescriptor } from '../../src/core/target.js';

let seq = 0;

/** Default: an enabled, unlabelled textbox — the legacy worst case. */
export function makeControl(partial: Partial<Control> = {}): Control {
  return {
    ref: `c${++seq}`,
    role: 'textbox',
    name: '',
    labels: [],
    container: [],
    frame: ['main'],
    ordinal: 0,
    enabled: true,
    bbox: { x: 0, y: 0, w: 120, h: 20 },
    ...partial,
  };
}

const LOCUS = 'https://bank.internal/backoffice/member.jsp';

export function makeObservation(controls: Control[], partial: Partial<Observation> = {}): Observation {
  return {
    id: 'obs-1',
    surface: 'web',
    locus: LOCUS,
    title: 'MEMBER INQUIRY',
    frames: [{ name: 'main', url: LOCUS }],
    controls,
    // Derived so `text` predicates see the same words the controls carry unless
    // a test overrides it deliberately.
    text: controls.map((c) => [c.name, ...c.labels, c.value ?? ''].filter(Boolean).join(' ')).join('\n'),
    fingerprint: 'fp-member-inquiry',
    viewport: { w: 1280, h: 900 },
    capturedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

/** Parsed so schema defaults (mode, minScore, minMargin, …) always apply. */
export const makeTarget = (t: z.input<typeof zTargetDescriptor>): TargetDescriptor => zTargetDescriptor.parse(t);

/** Deterministic permutations, so shuffle-invariance tests never flake. */
export function permutations<T>(xs: T[]): T[][] {
  const out: T[][] = [xs.slice(), xs.slice().reverse()];
  for (let k = 1; k < xs.length; k++) out.push([...xs.slice(k), ...xs.slice(0, k)]);
  return out;
}
