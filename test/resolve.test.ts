import { describe, expect, it } from 'vitest';
import { Resolution, resolveTarget, scoreControl } from '../src/core/resolve.js';
import { Control } from '../src/core/target.js';
import { makeControl, makeObservation, makeTarget, permutations } from './helpers/fixtures.js';

function resolved(r: Resolution) {
  if (r.status !== 'resolved') throw new Error(`expected resolved, got ${r.status}`);
  return r;
}

/** A legacy member-inquiry form: captions live in a table cell to the left, not in markup. */
function memberForm(churn: string): Control[] {
  return [
    makeControl({ ref: `${churn}-mbr`, labels: ['MBR NO'], hint: { tag: 'input', attrName: `txtMbr_${churn}`, type: 'text' } }),
    makeControl({ ref: `${churn}-ssn`, labels: ['SSN'], hint: { tag: 'input', attrName: `txtSsn_${churn}`, type: 'text' } }),
    makeControl({ ref: `${churn}-go`, role: 'button', name: 'INQUIRE', bbox: { x: 300, y: 0, w: 60, h: 20 } }),
  ];
}

describe('resolveTarget: legacy captions', () => {
  it('resolves a control with an empty accessible name from its inferred caption', () => {
    const obs = makeObservation(memberForm('a1'));
    const r = resolved(resolveTarget(obs, makeTarget({ role: 'textbox', name: { value: 'MBR NO' } })));
    expect(r.control.ref).toBe('a1-mbr');
    expect(r.control.name).toBe('');
    expect(r.runnerUp ?? 0).toBeLessThan(r.score);
  });

  it('ignores randomized ids: the same screen resolves identically under id churn', () => {
    const d = makeTarget({ role: 'textbox', name: { value: 'MBR NO' } });
    const first = makeObservation(memberForm('a1'));
    const second = makeObservation(memberForm('zz9'), { id: 'obs-2' });

    const a = resolved(resolveTarget(first, d));
    const b = resolved(resolveTarget(second, d));

    // Structural identity churned (refs and hint ids differ); semantic identity did not.
    expect(a.control.ref).not.toBe(b.control.ref);
    expect(a.control.hint?.attrName).not.toBe(b.control.hint?.attrName);
    expect(first.controls.indexOf(a.control)).toBe(second.controls.indexOf(b.control));
    expect(a.control.labels).toEqual(b.control.labels);
    expect(a.score).toBe(b.score);
  });

  it('never accepts a match on a stale recorded id alone', () => {
    // The descriptor carries the id seen at discovery time; the app has since
    // reassigned that id to an unrelated field.
    const obs = makeObservation([
      makeControl({ ref: 'moved', labels: ['MBR NO'], hint: { attrName: 'txt_002' } }),
      makeControl({ ref: 'impostor', labels: ['TELLER ID'], hint: { attrName: 'txt_001' } }),
    ]);
    const r = resolved(resolveTarget(obs, makeTarget({
      role: 'textbox', name: { value: 'MBR NO' }, hint: { attrName: 'txt_001' },
    })));
    expect(r.control.ref).toBe('moved');
  });
});

describe('resolveTarget: cross-tenant synonyms', () => {
  const d = makeTarget({
    role: 'textbox',
    name: { value: 'MBR NO', alternatives: ['MEMBER NUMBER'] },
    // The synonym penalty is deliberately small, so a head-to-head between the
    // primary and a synonym is a narrow win rather than a landslide.
    minMargin: 0.02,
  });

  it('resolves against a tenant that renamed the caption', () => {
    const obs = makeObservation([
      makeControl({ ref: 'renamed', labels: ['MEMBER NUMBER'] }),
      makeControl({ ref: 'other', labels: ['BRANCH'] }),
    ]);
    expect(resolved(resolveTarget(obs, d)).control.ref).toBe('renamed');
  });

  it('prefers the primary caption when both spellings are on screen', () => {
    const primary = makeControl({ ref: 'primary', labels: ['MBR NO'] });
    const synonym = makeControl({ ref: 'synonym', labels: ['MEMBER NUMBER'] });
    expect(scoreControl(d, primary).score).toBeGreaterThan(scoreControl(d, synonym).score);
    expect(resolved(resolveTarget(makeObservation([synonym, primary]), d)).control.ref).toBe('primary');
  });
});

describe('resolveTarget: refusing to guess', () => {
  it('reports ambiguity instead of flipping a coin between two SUBMIT buttons', () => {
    const obs = makeObservation([
      makeControl({ ref: 'submit-top', role: 'button', name: 'SUBMIT', bbox: { x: 0, y: 10, w: 60, h: 20 } }),
      makeControl({ ref: 'submit-bottom', role: 'button', name: 'SUBMIT', ordinal: 1, bbox: { x: 0, y: 400, w: 60, h: 20 } }),
    ]);
    const r = resolveTarget(obs, makeTarget({ role: 'button', name: { value: 'SUBMIT' } }));
    if (r.status !== 'ambiguous') throw new Error(`expected ambiguous, got ${r.status}`);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.map((c) => c.control.ref).sort()).toEqual(['submit-bottom', 'submit-top']);
  });

  it('fails outright when a required corroborating caption is absent', () => {
    const obs = makeObservation(memberForm('a1'));
    const r = resolveTarget(obs, makeTarget({
      role: 'textbox', name: { value: 'MBR NO' }, labels: ['JOINT OWNER'],
    }));
    expect(r.status).toBe('not_found');
    if (r.status !== 'not_found') return;
    // The caption-matching control was still the best candidate; it was penalised
    // below the floor rather than accepted at low confidence.
    expect(r.best?.control.ref).toBe('a1-mbr');
    expect(r.best?.score ?? 1).toBeLessThan(0.55);
    expect(r.considered).toBe(obs.controls.length);
  });
});

describe('resolveTarget: legacy grids', () => {
  const cell = (ref: string, row: string, column: string, value: string) =>
    makeControl({ ref, role: 'cell', labels: [column, row], value, container: ['MEMBER ACCOUNTS'] });

  const grid = makeObservation([
    makeControl({ ref: 'r1c0', role: 'cell', name: 'REG SAVINGS', labels: ['ACCOUNT TYPE'], container: ['MEMBER ACCOUNTS'] }),
    cell('r1c1', 'REG SAVINGS', 'CURRENT BALANCE', '1,204.55'),
    cell('r1c2', 'REG SAVINGS', 'AVAILABLE BALANCE', '1,100.00'),
    makeControl({ ref: 'r2c0', role: 'cell', name: 'CHECKING', labels: ['ACCOUNT TYPE'], container: ['MEMBER ACCOUNTS'] }),
    cell('r2c1', 'CHECKING', 'CURRENT BALANCE', '87.10'),
    cell('r2c2', 'CHECKING', 'AVAILABLE BALANCE', '87.10'),
  ]);

  it('picks the cell at the intersection of row label and column header', () => {
    const d = makeTarget({ role: 'cell', name: { value: 'CURRENT BALANCE' }, labels: ['REG SAVINGS'] });
    const r = resolved(resolveTarget(grid, d));
    expect(r.control.ref).toBe('r1c1');
    expect(r.control.value).toBe('1,204.55');

    const savings = grid.controls.find((c) => c.ref === 'r1c1')!;
    const checking = grid.controls.find((c) => c.ref === 'r2c1')!;
    expect(scoreControl(d, checking).score).toBeLessThan(scoreControl(d, savings).score);
  });

  it('uses an explicit ordinal to pick deterministically among identical row controls', () => {
    const rows = [0, 1, 2].map((i) => makeControl({
      ref: `void-${i}`, role: 'button', name: 'VOID', ordinal: i, bbox: { x: 500, y: 40 + i * 24, w: 50, h: 20 },
    }));
    const obs = makeObservation([...rows, makeControl({ ref: 'cancel', role: 'button', name: 'CANCEL' })]);

    for (const i of [0, 1, 2]) {
      const r = resolved(resolveTarget(obs, makeTarget({ role: 'button', name: { value: 'VOID' }, ordinal: i })));
      expect(r.control.ref).toBe(`void-${i}`);
    }
    expect(resolveTarget(obs, makeTarget({ role: 'button', name: { value: 'VOID' }, ordinal: 7 })).status).toBe('not_found');
  });
});

describe('resolveTarget: determinism', () => {
  const controls = [
    makeControl({ ref: 'void-0', role: 'button', name: 'VOID', ordinal: 0, bbox: { x: 500, y: 40, w: 50, h: 20 } }),
    makeControl({ ref: 'void-1', role: 'button', name: 'VOID', ordinal: 1, bbox: { x: 500, y: 64, w: 50, h: 20 } }),
    makeControl({ ref: 'void-2', role: 'button', name: 'VOID', ordinal: 2, bbox: { x: 500, y: 88, w: 50, h: 20 } }),
    makeControl({ ref: 'post', role: 'button', name: 'POST' }),
    makeControl({ ref: 'mbr', labels: ['MBR NO'] }),
  ];

  it('returns the same ref when the same observation is scored twice', () => {
    const obs = makeObservation(controls);
    const d = makeTarget({ role: 'textbox', name: { value: 'MBR NO' } });
    const first = resolved(resolveTarget(obs, d));
    const second = resolved(resolveTarget(obs, d));
    expect(second.control.ref).toBe(first.control.ref);
    expect(second.score).toBe(first.score);
  });

  it('is invariant to the order controls arrive in', () => {
    const d = makeTarget({ role: 'button', name: { value: 'VOID' }, ordinal: 1 });
    const refs = permutations(controls).map((cs) => resolved(resolveTarget(makeObservation(cs), d)).control.ref);
    expect(new Set(refs).size).toBe(1);
    expect(refs[0]).toBe('void-1');
  });
});
