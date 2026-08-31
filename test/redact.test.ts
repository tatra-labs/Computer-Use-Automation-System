import { describe, expect, it } from 'vitest';
import { hashRef, Redactor } from '../src/policy/redact.js';

const SSN = '412-88-7301';
const PAN = '4111 1111 1111 1111';
const EMAIL = 'j.doe+backoffice@riverbend-cu.example';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MTIiLCJyb2xlIjoidGVsbGVyIn0.q7Xn2Lm9PzT4kAeR1cVbHs';

describe('Redactor: pattern scrubbing', () => {
  const r = new Redactor();

  it('catches the built-in regulated formats', () => {
    for (const [input, label] of [[SSN, 'ssn'], [PAN, 'pan'], [EMAIL, 'email'], [JWT, 'jwt']] as const) {
      const out = r.text(`before ${input} after`);
      expect(out).toContain(`«${label}»`);
      expect(out).not.toContain(input);
      expect(out.startsWith('before ')).toBe(true);
    }
  });

  it('keeps the key but drops the value of a credential assignment', () => {
    const out = r.text('login: password=Sw0rdf1sh!2026 remember=1');
    expect(out).toContain('password=«credential»');
    expect(out).not.toContain('Sw0rdf1sh');
    expect(out).toContain('remember=1');
  });

  it('leaves ordinary back-office text alone', () => {
    const clean = 'MBR NO 000123456 REG SAVINGS CURRENT BALANCE 1,204.55';
    expect(r.text(clean)).toBe(clean);
  });

  it('honours extra configured patterns', () => {
    const custom = new Redactor(['TLR-[0-9]{4}']);
    expect(custom.text('teller TLR-4417 posted')).toBe('teller «custom» posted');
    // A malformed configured regex is ignored rather than crashing the redactor.
    expect(new Redactor(['([unclosed']).text('teller TLR-4417')).toBe('teller TLR-4417');
  });
});

describe('Redactor: registered values', () => {
  it('scrubs a known secret anywhere it appears, in any format', () => {
    const r = new Redactor();
    r.registerValue('Qw7zzTeller', 'secret');
    expect(r.text('note Qw7zzTeller here')).toBe('note «secret» here');
    // Including where no pattern would have recognised it: no delimiters, no keyword.
    expect(r.text('SESSION=xxQw7zzTellerYY')).not.toContain('Qw7zzTeller');
    expect(r.text('a Qw7zzTeller b Qw7zzTeller')).toBe('a «secret» b «secret»');
  });

  it('labels the scrub so a reader knows what was removed', () => {
    const r = new Redactor();
    r.registerValue('000123456', 'memberId');
    expect(r.text('MBR NO 000123456')).toBe('MBR NO «memberId»');
  });

  it('ignores values too short to scrub safely', () => {
    const r = new Redactor();
    r.registerValue('the', 'pii');
    r.registerValue('', 'pii');
    r.registerValue(undefined, 'pii');
    const text = 'the theatre is there';
    expect(r.text(text)).toBe(text);
  });

  it('treats a registered value as a literal, not a regex', () => {
    const r = new Redactor();
    r.registerValue('a.c(d)', 'secret');
    expect(r.text('abcxd')).toBe('abcxd');
    expect(r.text('x a.c(d) y')).toBe('x «secret» y');
  });
});

describe('Redactor.json', () => {
  const r = new Redactor();
  const payload = {
    member: {
      ssn: SSN,
      email: EMAIL,
      notes: ['card on file 4111 1111 1111 1111', { memo: `sent to ${EMAIL}` }],
    },
    auth: { token: 'tok_live_9aa8bb7cc6dd', cookie: 'JSESSIONID=8F2A11CDEF' },
    password: 'Sw0rdf1sh!2026',
    counts: { steps: 3, ok: true, note: null },
  };
  const out = r.json(payload);
  const serialized = JSON.stringify(out);

  it('replaces sensitive keys with a hash reference, whatever the value looks like', () => {
    for (const [got, key] of [[out.member.ssn, 'ssn'], [out.auth.token, 'token'], [out.auth.cookie, 'cookie'], [out.password, 'password']] as const) {
      expect(got).toMatch(new RegExp(`^«${key}:sha256:[0-9a-f]{12}»$`));
    }
    expect(serialized).not.toContain('Sw0rdf1sh');
    expect(serialized).not.toContain('JSESSIONID=8F2A11CDEF');
    expect(serialized).not.toContain(SSN);
  });

  it('deep-redacts strings inside nested objects and arrays', () => {
    expect(out.member.email).toBe('«email»');
    expect(out.member.notes[0]).toContain('«pan»');
    const nested = out.member.notes[1];
    expect(typeof nested === 'object' && nested !== null ? nested.memo : '').toBe('sent to «email»');
    expect(serialized).not.toContain(EMAIL);
  });

  it('leaves non-sensitive scalars and the input object untouched', () => {
    expect(out.counts).toEqual({ steps: 3, ok: true, note: null });
    expect(payload.password).toBe('Sw0rdf1sh!2026');
    expect(payload.member.ssn).toBe(SSN);
  });
});

describe('hashRef', () => {
  it('is stable, collision-distinguishing, and non-reversing', () => {
    expect(hashRef('Sw0rdf1sh!2026')).toBe(hashRef('Sw0rdf1sh!2026'));
    expect(hashRef('Sw0rdf1sh!2026')).not.toBe(hashRef('Sw0rdf1sh!2027'));
    expect(hashRef('Sw0rdf1sh!2026')).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(hashRef('Sw0rdf1sh!2026')).not.toContain('Sw0rdf1sh');
  });
});

describe('Redactor.wouldRedact', () => {
  it('is true exactly when text() would change the string', () => {
    const r = new Redactor();
    r.registerValue('Qw7zzTeller', 'secret');
    const samples = [
      'MBR NO 000123456',
      `SSN ${SSN}`,
      `card ${PAN}`,
      'Qw7zzTeller',
      'password=hunter2000',
      'REG SAVINGS 1,204.55',
      '',
    ];
    for (const s of samples) expect(r.wouldRedact(s)).toBe(r.text(s) !== s);
    // …and the tripwire actually fires on at least one of them.
    expect(samples.filter((s) => r.wouldRedact(s)).length).toBe(4);
  });
});
