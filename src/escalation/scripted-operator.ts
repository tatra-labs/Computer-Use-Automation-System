/**
 * A stand-in for the person at the operator console.
 *
 * What is real here: the control transfer, the lease epochs, the recording of
 * human actions, and — importantly — the *input path*. The scripted operator
 * drives the live page through `surface.operator.click(x, y)` and
 * `surface.operator.typeText(...)`: raw mouse and keyboard against real
 * viewport coordinates, exactly the channel the console's live view uses. It
 * cannot use the automation's ref-based actions, because a human does not have
 * refs.
 *
 * What is simulated: the human's judgement. That is the piece the brief lets us
 * mock, and mocking it is what makes the handoff testable in CI.
 */
import type { Control } from '../core/target.js';
import type { InterventionRequest, InterventionStore } from './intervention.js';
import type { LiveSession } from './operator-console.js';

export interface OperatorDecision {
  decision: 'resumed' | 'completed_manually' | 'aborted' | 'denied';
  note: string;
}

export type OperatorPlaybook = (ctx: {
  intervention: InterventionRequest;
  hands: OperatorHands;
}) => Promise<OperatorDecision>;

/** The only things a human at a screen can actually do. */
export class OperatorHands {
  constructor(private session: LiveSession) {}

  private record(kind: 'click' | 'type' | 'key' | 'scroll' | 'note', detail: string): void {
    this.session.lease.recordHumanAction({ at: new Date().toISOString(), kind, detail: this.session.redactor.text(detail) });
  }

  /** Find a control by eye, then click where it is on screen. */
  async clickWhere(match: (c: Control) => boolean, label: string): Promise<boolean> {
    const obs = await this.session.surface.observe();
    const hit = obs.controls.find(match);
    if (!hit) { this.record('note', `looked for ${label} and could not see it`); return false; }
    const x = Math.round(hit.bbox.x + hit.bbox.w / 2);
    const y = Math.round(hit.bbox.y + hit.bbox.h / 2);
    await this.session.surface.operator.click(x, y);
    this.record('click', `${label} at (${x},${y})`);
    return true;
  }

  async typeText(text: string): Promise<void> {
    await this.session.surface.operator.typeText(text);
    // Never record raw keystrokes: they may be credentials or member data.
    this.record('type', `typed ${text.length} characters`);
  }

  async key(key: string): Promise<void> {
    await this.session.surface.operator.key(key);
    this.record('key', key);
  }

  async note(text: string): Promise<void> {
    this.record('note', text);
  }

  async seesText(pattern: RegExp): Promise<boolean> {
    const obs = await this.session.surface.observe();
    return pattern.test(obs.text);
  }
}

export class ScriptedOperator {
  private handled = new Set<string>();
  private detach: (() => void) | undefined;

  constructor(
    private store: InterventionStore,
    private resolveSession: (sessionId: string) => LiveSession | undefined,
    private playbook: OperatorPlaybook,
    readonly name = 'sim.duty-officer',
  ) {}

  attach(): () => void {
    const onChange = (i: InterventionRequest) => {
      if (i.status !== 'open' || this.handled.has(i.id)) return;
      this.handled.add(i.id);
      // Break out of the store's synchronous notification before touching the page.
      setImmediate(() => { void this.handle(i); });
    };
    this.detach = this.store.onChange(onChange);
    for (const i of this.store.list()) onChange(i);
    return () => this.detach?.();
  }

  private async handle(i: InterventionRequest): Promise<void> {
    const session = this.resolveSession(i.sessionId);
    if (!session) {
      this.store.update(i.id, {
        status: 'abandoned',
        resolution: { at: new Date().toISOString(), by: this.name, decision: 'aborted', note: 'session is no longer live', humanActions: [] },
      });
      return;
    }

    // Take control of the live session, exactly as the console's "Take control"
    // button does. Until this returns, automation is locked out by the lease.
    session.lease.cedeTo(`operator:${this.name}`, `taking control for ${i.reason}`);
    this.store.update(i.id, { status: 'operator_in_control', lease: session.lease.current });

    const hands = new OperatorHands(session);
    let outcome: OperatorDecision;
    try {
      outcome = await this.playbook({ intervention: i, hands });
    } catch (e) {
      outcome = { decision: 'aborted', note: `operator script failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    session.lease.returnToAutomation('automation', outcome.note);
    this.store.update(i.id, {
      status: outcome.decision === 'aborted' ? 'abandoned' : 'resolved',
      lease: session.lease.current,
      resolution: {
        at: new Date().toISOString(),
        by: this.name,
        decision: outcome.decision,
        note: outcome.note,
        humanActions: [...session.lease.recordedHumanActions],
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Playbooks used by the demo runs
// ---------------------------------------------------------------------------

/** A duty officer who approves risky steps after reading the screen. */
export const approveRiskyStep: OperatorPlaybook = async ({ intervention, hands }) => {
  if (intervention.reason !== 'CONFIRMATION_REQUIRED') {
    return { decision: 'aborted', note: `not an approval request (${intervention.reason})` };
  }
  await hands.note(`reviewed "${intervention.summary}" on the live screen and approved it`);
  return { decision: 'resumed', note: 'approved: sub-account opening is within this operator\'s authority' };
};

/**
 * A duty officer who finishes a step the automation could not target, using the
 * keyboard and mouse, then hands back.
 */
export function completeLookupManually(memberId: string): OperatorPlaybook {
  return async ({ intervention, hands }) => {
    await hands.note(`automation could not proceed (${intervention.reason}); completing the lookup by hand`);

    const field = await hands.clickWhere(
      (c) => (c.role === 'textbox' || c.role === 'combobox') &&
        c.labels.some((l) => /MBR\s*NO|MEMBER\s*(NUMBER|#)/i.test(l)),
      'the member-number field',
    );
    if (!field) return { decision: 'aborted', note: 'could not find the member-number field on screen either' };

    await hands.typeText(memberId);
    const searched = await hands.clickWhere(
      (c) => c.role === 'button' && /INQUIRE|SEARCH|SUBMIT/i.test(c.name),
      'the inquiry button',
    );
    if (!searched) await hands.key('Enter');

    if (await hands.seesText(/CURRENT BALANCE|SAVINGS/i)) {
      return { decision: 'completed_manually', note: 'looked the member up by hand; member detail is on screen' };
    }
    return { decision: 'resumed', note: 'attempted the lookup manually; handing back for the automation to verify' };
  };
}
