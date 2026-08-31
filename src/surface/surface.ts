/**
 * The surface seam.
 *
 * Above this interface nothing knows what a browser is. The replay engine, the
 * resolver, the artifact schema and the LLM prompt all operate on Observations
 * and refs. A desktop driver (Windows UI Automation) or a screenshot+coordinate
 * driver implements the same nine methods and the rest of the system is
 * unchanged — that is the property the design is buying.
 *
 * `ref`s are ephemeral handles minted by the most recent `observe()`. Callers
 * observe, resolve a TargetDescriptor to a ref, then act. A stale ref is a
 * SurfaceError, never a silent mis-click.
 */
import type { Observation } from '../core/target.js';

export class SurfaceError extends Error {
  constructor(message: string, override readonly cause?: unknown) { super(message); this.name = 'SurfaceError'; }
}

export interface TypeOptions { clearFirst: boolean; pressEnter: boolean }

export interface Surface {
  readonly kind: 'web' | 'desktop';

  /** Perceive current state. Mints fresh refs; invalidates previous ones. */
  observe(): Promise<Observation>;

  navigate(locus: string): Promise<void>;
  click(ref: string): Promise<void>;
  type(ref: string, text: string, opts: TypeOptions): Promise<void>;
  select(ref: string, value: string): Promise<void>;
  press(key: string): Promise<void>;

  /** Answer a modal the surface put up. Never implicit. */
  answerDialog(decision: 'accept' | 'dismiss'): Promise<void>;

  /** Viewport-sized PNG. Also the operator console's live view. */
  screenshot(): Promise<Buffer>;
  /** Richer failure evidence: serialized source of every frame. */
  sourceSnapshot(): Promise<string>;

  currentLocus(): string;
  close(): Promise<void>;

  /**
   * Raw human input forwarded into the *same live session*. Coordinates are in
   * CSS pixels of the same viewport the screenshot came from, so an operator
   * clicking the live view clicks the real control.
   */
  operator: {
    click(x: number, y: number): Promise<void>;
    typeText(text: string): Promise<void>;
    key(key: string): Promise<void>;
    scroll(dx: number, dy: number): Promise<void>;
  };
}
