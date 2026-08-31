import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ActionContext, Decision, PolicyGate, zPolicy } from '../src/policy/policy.js';

type PolicyInput = z.input<typeof zPolicy>;

const BASE: PolicyInput = {
  version: 1,
  allowlist: {
    loci: ['^https://bank\\.internal/backoffice/'],
    actions: ['navigate', 'click', 'type', 'observe', 'assert', 'extract'],
  },
  risk: {},
  limits: {},
};

/** Parsed through the schema so every default the real system relies on applies. */
const gate = (over: Partial<PolicyInput> = {}): PolicyGate => new PolicyGate(zPolicy.parse({ ...BASE, ...over }));

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  kind: 'click',
  risk: 'read',
  locus: 'https://bank.internal/backoffice/member.jsp',
  confirmed: false,
  ...over,
});

/** Narrowing helpers: `reason` only exists on the denial and confirm variants. */
function denial(d: Decision): string {
  expect(d.allow).toBe(false);
  return d.allow ? '' : d.reason;
}
function confirmation(d: Decision): string {
  expect(d).toMatchObject({ allow: true, requiresConfirmation: true });
  return d.allow && d.requiresConfirmation ? d.reason : '';
}
function plainAllow(d: Decision): void {
  expect(d.allow).toBe(true);
  expect(d.allow && d.requiresConfirmation).toBeFalsy();
}

describe('PolicyGate.check: allowlists', () => {
  it('denies an action kind that is not listed', () => {
    expect(denial(gate().check(ctx({ kind: 'press' })))).toMatch(/action kind "press"/);
    plainAllow(gate().check(ctx({ kind: 'click' })));
  });

  it('denies a locus outside the allowlist regexes', () => {
    const g = gate();
    expect(denial(g.check(ctx({ locus: 'https://evil.example/backoffice/member.jsp' })))).toMatch(/outside the allowlist/);
    // Prefix-anchored: a matching path on the wrong host is still outside.
    expect(g.locusAllowed('https://bank.internal/public/login.jsp')).toBe(false);
    expect(g.locusAllowed('https://bank.internal/backoffice/txn/post.jsp')).toBe(true);
    plainAllow(g.check(ctx({ locus: 'https://bank.internal/backoffice/txn/post.jsp' })));
  });

  it('checks the allowlist before the risk disposition', () => {
    // An unlisted kind must not be able to buy its way in with a confirmation.
    expect(denial(gate().check(ctx({ kind: 'press', risk: 'read', confirmed: true })))).toMatch(/action kind/);
  });
});

describe('PolicyGate.check: risk dispositions', () => {
  it('asks for confirmation on an irreversible action, and takes it from either source', () => {
    const g = gate();
    expect(confirmation(g.check(ctx({ risk: 'irreversible' })))).toMatch(/irreversible/);
    plainAllow(g.check(ctx({ risk: 'irreversible', confirmed: true })));
    plainAllow(g.check(ctx({ risk: 'irreversible', confirmed: false, humanApproved: true })));
  });

  it('allows read and write by default', () => {
    plainAllow(gate().check(ctx({ risk: 'read' })));
    plainAllow(gate().check(ctx({ risk: 'write' })));
  });

  it('denies a blocked risk class even when the caller confirmed', () => {
    const g = gate({ risk: { irreversible: 'block' } });
    expect(denial(g.check(ctx({ risk: 'irreversible', confirmed: true, humanApproved: true })))).toMatch(/blocked by policy/);
  });

  it('applies confirm to any risk class it is configured for', () => {
    const g = gate({ risk: { write: 'confirm' } });
    expect(confirmation(g.check(ctx({ risk: 'write' })))).toMatch(/"write"/);
    plainAllow(g.check(ctx({ risk: 'read' })));
  });
});

describe('PolicyGate: budgets', () => {
  it('allows exactly the configured number of steps', () => {
    const g = gate({ limits: { maxSteps: 3 } });
    plainAllow(g.countStep());
    plainAllow(g.countStep());
    plainAllow(g.countStep());
    expect(denial(g.countStep())).toMatch(/step budget exhausted \(3\)/);
    expect(denial(g.countStep())).toMatch(/step budget/);
  });

  it('counts navigations and LLM calls independently', () => {
    const g = gate({ limits: { maxNavigations: 1, maxLlmCalls: 2 } });
    plainAllow(g.countNavigation());
    expect(denial(g.countNavigation())).toMatch(/navigation budget/);
    // Exhausting one budget must not consume another.
    plainAllow(g.countLlmCall());
    plainAllow(g.countLlmCall());
    expect(denial(g.countLlmCall())).toMatch(/LLM call budget/);
  });

  it('reports remaining time against the duration budget', () => {
    const g = gate({ limits: { maxDurationMs: 60_000 } });
    expect(g.expired()).toBe(false);
    expect(g.timeLeftMs()).toBeGreaterThan(0);
    expect(g.timeLeftMs()).toBeLessThanOrEqual(60_000);
    expect(gate({ limits: { maxDurationMs: 1 } }).timeLeftMs()).toBeLessThanOrEqual(1);
  });
});

type Cap = Parameters<PolicyGate['checkInvocation']>[0];

const cap = (over: Partial<Cap> = {}): Cap => ({
  approval: { state: 'approved' },
  stability: { replays: 12, successRate: 1 },
  policy: { allowUnattended: true, requiresConfirmation: ['irreversible'] },
  steps: [{ risk: 'read' }, { risk: 'write' }],
  ...over,
});

describe('PolicyGate.checkInvocation', () => {
  it('refuses unattended replay of a draft capability', () => {
    const d = gate().checkInvocation(cap({ approval: { state: 'draft' } }), { unattended: true, confirmed: true });
    expect(denial(d)).toMatch(/approval state "approved" \(is "draft"\)/);
  });

  it('permits unattended replay of an approved capability that opted in', () => {
    plainAllow(gate().checkInvocation(cap(), { unattended: true, confirmed: false }));
  });

  it('refuses unattended replay when the capability did not opt in', () => {
    const d = gate().checkInvocation(
      cap({ policy: { allowUnattended: false, requiresConfirmation: ['irreversible'] } }),
      { unattended: true, confirmed: true },
    );
    expect(denial(d)).toMatch(/not marked allowUnattended/);
  });

  it('gates unattended replay on the observed success rate', () => {
    const g = () => gate({ unattended: { minSuccessRate: 0.9 } });
    expect(denial(g().checkInvocation(cap({ stability: { replays: 10, successRate: 0.5 } }), { unattended: true, confirmed: true })))
      .toMatch(/success rate 0\.5 below required 0\.9/);
    // No observed rate at all is not a pass.
    expect(denial(g().checkInvocation(cap({ stability: { replays: 0 } }), { unattended: true, confirmed: true })))
      .toMatch(/below required 0\.9/);
    plainAllow(g().checkInvocation(cap({ stability: { replays: 10, successRate: 0.95 } }), { unattended: true, confirmed: true }));
  });

  it('does not apply the unattended gates to an attended invocation', () => {
    const g = gate({ unattended: { minSuccessRate: 0.9 } });
    plainAllow(g.checkInvocation(
      cap({ approval: { state: 'draft' }, stability: { replays: 0 }, policy: { allowUnattended: false, requiresConfirmation: [] } }),
      { unattended: false, confirmed: false },
    ));
  });

  it('requires confirmation when the flow contains a step of a confirm-class risk', () => {
    const risky = cap({ steps: [{ risk: 'read' }, { risk: 'irreversible' }, { risk: 'irreversible' }] });
    expect(confirmation(gate().checkInvocation(risky, { unattended: false, confirmed: false })))
      .toMatch(/2 step\(s\) of class \[irreversible\]/);
    plainAllow(gate().checkInvocation(risky, { unattended: false, confirmed: true }));
    // The capability's own list decides, not the step's risk label alone.
    plainAllow(gate().checkInvocation(
      cap({ steps: [{ risk: 'irreversible' }], policy: { allowUnattended: true, requiresConfirmation: [] } }),
      { unattended: false, confirmed: false },
    ));
  });
});
