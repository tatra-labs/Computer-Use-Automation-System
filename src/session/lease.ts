/**
 * The control-transfer model.
 *
 * A live session has exactly one controller at a time. Automation holds the
 * lease by default; escalation cedes it to a human operator; the human hands it
 * back. Every transfer bumps a monotonic `epoch`.
 *
 * Enforcement (not advice) is the point: the automation captures the epoch it
 * believes it holds and the guarded surface re-checks it immediately before and
 * after every single action. If a human took over mid-step, the action is
 * refused or the result is discarded, rather than two actors racing on the same
 * page. That is what makes "pause, cede, resume on the *same* session" safe.
 */
export type Controller = 'automation' | 'operator';

export interface LeaseState {
  owner: Controller;
  epoch: number;
  holder: string;
  since: string;
  reason?: string;
}

export interface HumanAction {
  at: string;
  kind: 'click' | 'type' | 'key' | 'scroll' | 'note';
  /** Coordinates / keys only. Typed text is redacted before it is recorded. */
  detail: string;
}

export class ControlLostError extends Error {
  constructor(readonly expected: number, readonly actual: number, readonly owner: Controller) {
    super(`control lease lost: expected epoch ${expected}, session is at ${actual} owned by "${owner}"`);
    this.name = 'ControlLostError';
  }
}

export class ControlLease {
  private state: LeaseState;
  private readonly log: LeaseState[] = [];
  private readonly humanActions: HumanAction[] = [];
  private watchers: Array<(s: LeaseState) => void> = [];

  constructor(holder: string) {
    this.state = { owner: 'automation', epoch: 1, holder, since: new Date().toISOString() };
    this.log.push(this.state);
  }

  get current(): LeaseState { return this.state; }
  get epoch(): number { return this.state.epoch; }
  get owner(): Controller { return this.state.owner; }
  get history(): readonly LeaseState[] { return this.log; }
  get recordedHumanActions(): readonly HumanAction[] { return this.humanActions; }

  /** Throws unless `controller` still holds the lease at exactly `epoch`. */
  assertHeld(controller: Controller, epoch: number): void {
    if (this.state.owner !== controller || this.state.epoch !== epoch) {
      throw new ControlLostError(epoch, this.state.epoch, this.state.owner);
    }
  }

  held(controller: Controller, epoch: number): boolean {
    return this.state.owner === controller && this.state.epoch === epoch;
  }

  /** Automation → operator. Returns the new epoch the operator holds. */
  cedeTo(holder: string, reason: string): number {
    return this.transfer({ owner: 'operator', holder, reason });
  }

  /** Operator → automation. Returns the new epoch automation must use. */
  returnToAutomation(holder: string, note: string): number {
    return this.transfer({ owner: 'automation', holder, reason: note });
  }

  private transfer(p: { owner: Controller; holder: string; reason: string }): number {
    this.state = {
      owner: p.owner,
      epoch: this.state.epoch + 1,
      holder: p.holder,
      since: new Date().toISOString(),
      reason: p.reason,
    };
    this.log.push(this.state);
    for (const w of this.watchers) w(this.state);
    return this.state.epoch;
  }

  recordHumanAction(a: HumanAction): void {
    this.humanActions.push(a);
  }

  onChange(cb: (s: LeaseState) => void): () => void {
    this.watchers.push(cb);
    return () => { this.watchers = this.watchers.filter((w) => w !== cb); };
  }
}
