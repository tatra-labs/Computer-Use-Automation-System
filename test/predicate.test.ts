import { describe, expect, it } from 'vitest';
import { evaluate, interpolate, Predicate } from '../src/core/predicate.js';
import { makeControl, makeObservation, makeTarget } from './helpers/fixtures.js';

const controls = [
  makeControl({ ref: 'mbr', labels: ['MBR NO'], value: '000123456' }),
  makeControl({ ref: 'post', role: 'button', name: 'POST TRANSACTION' }),
  makeControl({ ref: 'id-cell', role: 'cell', name: '000123456', labels: ['MEMBER NUMBER'] }),
];

const obs = makeObservation(controls, {
  locus: 'https://bank.internal/backoffice/txn/post.jsp?mbr=000123456',
  title: 'TRANSACTION POSTING',
  text: 'MEMBER 000123456 REG SAVINGS BALANCE 1,204.55',
});

const withDialog = makeObservation(controls, {
  pendingDialog: { kind: 'confirm', message: 'POST THIS TRANSACTION? THIS CANNOT BE UNDONE.' },
});

const postButton = makeTarget({ role: 'button', name: { value: 'POST TRANSACTION' } });
// Floor above the role-only baseline, so "some button exists" is not a match.
const deleteButton = makeTarget({ role: 'button', name: { value: 'DELETE MEMBER' }, minScore: 0.7 });
const present: Predicate = { kind: 'controlPresent', target: postButton };
const absent: Predicate = { kind: 'controlPresent', target: deleteButton };

describe('evaluate: leaf predicates', () => {
  it('detects control presence and absence', () => {
    expect(evaluate(present, obs).ok).toBe(true);
    expect(evaluate({ kind: 'controlAbsent', target: deleteButton }, obs).ok).toBe(true);
    expect(evaluate({ kind: 'controlAbsent', target: postButton }, obs).ok).toBe(false);
  });

  it('matches text, locus and title case-insensitively', () => {
    expect(evaluate({ kind: 'textMatches', pattern: 'reg savings' }, obs).ok).toBe(true);
    expect(evaluate({ kind: 'textMatches', pattern: 'RECORD NOT FOUND' }, obs).ok).toBe(false);
    expect(evaluate({ kind: 'textAbsent', pattern: 'RECORD NOT FOUND' }, obs).ok).toBe(true);
    expect(evaluate({ kind: 'textAbsent', pattern: 'reg savings' }, obs).ok).toBe(false);
    expect(evaluate({ kind: 'locusMatches', pattern: 'txn/post\\.jsp' }, obs).ok).toBe(true);
    expect(evaluate({ kind: 'locusMatches', pattern: 'member/edit' }, obs).ok).toBe(false);
    expect(evaluate({ kind: 'titleMatches', pattern: '^transaction' }, obs).ok).toBe(true);
    expect(evaluate({ kind: 'titleMatches', pattern: '^member' }, obs).ok).toBe(false);
  });

  it('detects a pending dialog, with and without a message pattern', () => {
    expect(evaluate({ kind: 'dialogPresent' }, withDialog).ok).toBe(true);
    expect(evaluate({ kind: 'dialogPresent', pattern: 'cannot be undone' }, withDialog).ok).toBe(true);
    expect(evaluate({ kind: 'dialogPresent', pattern: 'session expired' }, withDialog).ok).toBe(false);

    const none = evaluate({ kind: 'dialogPresent' }, obs);
    expect(none.ok).toBe(false);
    expect(none.detail).toMatch(/no pending dialog/);
    // A message pattern must not rescue an observation with no dialog at all.
    expect(evaluate({ kind: 'dialogPresent', pattern: '.*' }, obs).ok).toBe(false);
  });
});

describe('evaluate: composition', () => {
  it('all requires every branch and names only the failing ones', () => {
    expect(evaluate({ kind: 'all', of: [present, { kind: 'titleMatches', pattern: 'POSTING' }] }, obs).ok).toBe(true);

    const r = evaluate({
      kind: 'all',
      of: [{ kind: 'titleMatches', pattern: 'POSTING' }, { kind: 'textMatches', pattern: 'NOT A CHANCE' }],
    }, obs);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('NOT A CHANCE');
    expect(r.detail).not.toContain('title');
  });

  it('any needs one branch and reports which one satisfied it', () => {
    const r = evaluate({ kind: 'any', of: [{ kind: 'textMatches', pattern: 'NOT A CHANCE' }, present] }, obs);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('controlPresent');

    const none = evaluate({ kind: 'any', of: [{ kind: 'textMatches', pattern: 'NOPE' }, absent] }, obs);
    expect(none.ok).toBe(false);
    expect(none.detail).toContain('NOPE');
    expect(none.detail).toContain('controlPresent');
  });

  it('not inverts, and nests', () => {
    expect(evaluate({ kind: 'not', of: present }, obs).ok).toBe(false);
    expect(evaluate({ kind: 'not', of: absent }, obs).ok).toBe(true);
    expect(evaluate({ kind: 'not', of: { kind: 'not', of: present } }, obs).ok).toBe(true);
  });
});

describe('interpolate', () => {
  it('substitutes params and tolerates whitespace inside the braces', () => {
    expect(interpolate('RECORD NOT FOUND FOR MBR {{memberId}}', { memberId: '000123456' }))
      .toBe('RECORD NOT FOUND FOR MBR 000123456');
    expect(interpolate('{{ memberId }}', { memberId: 7 })).toBe('7');
  });

  it('leaves an unknown param literal rather than writing "undefined"', () => {
    expect(interpolate('STATUS {{who}}', { memberId: '1' })).toBe('STATUS {{who}}');
    // Behaviourally: a missing param must not accidentally match a screen that
    // happens to render the word "undefined".
    const leaky = makeObservation([], { text: 'STATUS undefined' });
    expect(evaluate({ kind: 'textMatches', pattern: 'STATUS {{who}}' }, leaky, {}).ok).toBe(false);
    expect(evaluate({ kind: 'textMatches', pattern: 'STATUS {{who}}' }, leaky, { who: 'undefined' }).ok).toBe(true);
  });

  it('substitutes inside a target name', () => {
    // minScore above the role-only baseline, so a wrong id fails instead of
    // matching on role alone.
    const p: Predicate = {
      kind: 'controlPresent',
      target: makeTarget({ role: 'cell', name: { value: '{{memberId}}' }, minScore: 0.7 }),
    };
    expect(evaluate(p, obs, { memberId: '000123456' }).ok).toBe(true);
    expect(evaluate(p, obs, { memberId: '000999999' }).ok).toBe(false);
    expect(evaluate(p, obs, {}).ok).toBe(false);
  });

  it('substitutes inside target alternatives', () => {
    const p: Predicate = {
      kind: 'controlPresent',
      target: makeTarget({
        role: 'textbox',
        name: { value: 'NO SUCH CAPTION', alternatives: ['{{caption}}'] },
        minScore: 0.7,
      }),
    };
    expect(evaluate(p, obs, { caption: 'MBR NO' }).ok).toBe(true);
    expect(evaluate(p, obs, {}).ok).toBe(false);
  });
});
