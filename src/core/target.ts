/**
 * The perception vocabulary. Everything above this layer — artifacts, replay,
 * the resolver, the LLM prompt — speaks only in these terms, never in CSS,
 * XPath, or pixel coordinates. That is the seam that lets a desktop surface
 * (UI Automation / AX API) plug in behind the same replay engine: it has roles,
 * names, values, containment and geometry too.
 */
import { z } from 'zod';

/**
 * A closed role vocabulary. Web AX roles and Windows UIA control types both map
 * onto it; anything unmapped becomes 'unknown' and is still addressable by
 * name + container, just with less discriminating power.
 */
export const zRole = z.enum([
  'button', 'link', 'textbox', 'password', 'combobox', 'option', 'checkbox', 'radio',
  'tab', 'menuitem', 'cell', 'columnheader', 'row', 'heading', 'text', 'alert',
  'dialog', 'image', 'unknown',
]);
export type Role = z.infer<typeof zRole>;

export interface Box { x: number; y: number; w: number; h: number }

/**
 * One addressable thing on the surface, described the way a human perceives it.
 *
 * `name` is the computed accessible name. Legacy enterprise markup very often
 * yields '' — no <label for>, no aria-label — so `labels` carries captions
 * *inferred from layout* (the caption cell to the left, the column header
 * above, the enclosing fieldset legend). Those inferred captions are the
 * primary locator signal on legacy surfaces.
 */
export interface Control {
  /** Ephemeral handle, valid only within the observation that produced it. */
  ref: string;
  role: Role;
  name: string;
  /** Inferred captions, most-specific first. */
  labels: string[];
  value?: string;
  description?: string;
  /** Enclosing section / table / form captions, outermost first. */
  container: string[];
  /** Frame name chain (framesets and iframes are the norm in legacy apps). */
  frame: string[];
  /** 0-based index among controls sharing role + primary label in the same frame+container. */
  ordinal: number;
  enabled: boolean;
  bbox: Box;
  /**
   * Weak, surface-specific tie-breakers. Deliberately quarantined: the resolver
   * gives them low weight and never accepts a match on a hint alone, because
   * generated ids churn between renders and releases.
   */
  hint?: { tag?: string; attrName?: string; type?: string };
}

export interface FrameInfo { name: string; url: string }

/** One perception of the surface at a point in time. */
export interface Observation {
  id: string;
  surface: 'web' | 'desktop';
  /** URL, or window identity on a desktop surface. */
  locus: string;
  title: string;
  frames: FrameInfo[];
  controls: Control[];
  /** Normalized visible text across all frames — for coarse state predicates. */
  text: string;
  /** A modal the surface put up that must be answered before anything else. */
  pendingDialog?: { kind: string; message: string };
  /** Structural hash: role+label shape, ignoring values. Drift signal. */
  fingerprint: string;
  viewport: { w: number; h: number };
  capturedAt: string;
}

// ---------------------------------------------------------------------------
// TargetDescriptor — how an artifact says *which* control, portably
// ---------------------------------------------------------------------------

export const zNameMatch = z.object({
  /** Literal to match, or `{{param}}` to interpolate an input at replay time. */
  value: z.string(),
  mode: z.enum(['exact', 'contains', 'regex']).default('exact'),
  /**
   * Synonyms for the same control in other tenant configurations / versions of
   * the same vendor product ('MBR NO' vs 'MEMBER NUMBER'). A synonym match
   * scores slightly below the primary so the primary always wins when both are
   * present. This is what makes one artifact reusable across tenants without
   * an override.
   */
  alternatives: z.array(z.string()).default([]),
});

export const zTargetDescriptor = z.object({
  role: zRole,
  /** Matched against the accessible name AND the inferred layout captions. */
  name: zNameMatch.optional(),
  /** Additional captions that must corroborate (e.g. row label + column header). */
  labels: z.array(z.string()).default([]),
  container: z.array(z.string()).default([]),
  frame: z.array(z.string()).default([]),
  /** Deterministic tie-break among equally-scored candidates. */
  ordinal: z.number().int().min(0).optional(),
  hint: z.object({ tag: z.string().optional(), attrName: z.string().optional(), type: z.string().optional() }).optional(),
  /** Acceptance floor. Below it, resolution fails rather than guessing. */
  minScore: z.number().min(0).max(1).default(0.55),
  /**
   * Required lead over the runner-up. Prevents "clicked the wrong SUBMIT"
   * failures by turning near-ties into an explicit AMBIGUOUS_TARGET.
   */
  minMargin: z.number().min(0).max(1).default(0.08),
  /** Human-readable note recorded at discovery time, for reviewers. */
  note: z.string().optional(),
});
export type TargetDescriptor = z.infer<typeof zTargetDescriptor>;
