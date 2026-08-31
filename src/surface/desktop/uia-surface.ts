/**
 * Windows UI Automation surface — typed, unimplemented on purpose.
 *
 * The point of this file is the negative result: nothing above the surface seam
 * changes to target a desktop app. The artifact schema (src/core/artifact.ts),
 * the resolver (src/core/resolve.ts), the predicate evaluator and the replay
 * engine are untouched, because a TargetDescriptor is expressed in role +
 * accessible name + inferred captions + containment + ordinal, and UIA provides
 * every one of those natively: ControlType, Name, the TreeWalker for
 * containment/adjacency, and BoundingRectangle for geometry. The mapping is a
 * pure function of a UIA element, which is why the two helpers below are real
 * and unit-tested while every I/O method throws.
 *
 * AutomationId is the desktop analogue of a DOM id: stable in a well-built app,
 * regenerated per-build by the WinForms/Delphi/PowerBuilder screens that make up
 * the actual back-office estate. So it goes where the DOM id goes — into
 * Control.hint, which the resolver weights at 0.06 and never accepts a match on
 * alone.
 */
import type { Surface, TypeOptions } from '../surface.js';
import { SurfaceError } from '../surface.js';
import type { Box, Control, Observation, Role } from '../../core/target.js';
import { norm } from '../../core/resolve.js';

/**
 * What a UIA provider actually hands you per element, flattened: the properties
 * a sidecar can read in one pass without holding COM pointers across the RPC
 * boundary. `ancestors` is the TreeWalker parent chain, innermost first.
 */
export interface UiaElement {
  controlType: string;
  name: string;
  automationId: string;
  className: string;
  value?: string;
  helpText?: string;
  isEnabled: boolean;
  /** Screen coordinates, as UIA reports them. */
  boundingRectangle: { left: number; top: number; right: number; bottom: number };
  ancestors: Array<{ controlType: string; name: string }>;
}

/**
 * Canonical UIA ControlType name → the closed Role vocabulary.
 *
 * Container types deliberately land on 'unknown' rather than being forced into a
 * near-neighbour: 'unknown' still scores 0.7 against any concrete role in
 * resolve.ts, whereas a wrong concrete role scores 0 and makes the control
 * unaddressable. Three roles cannot come from ControlType at all and are noted
 * where they would be derived instead.
 */
const ROLE_BY_CONTROL_TYPE: Record<string, Role> = {
  button: 'button',
  splitbutton: 'button',
  appbar: 'button',
  hyperlink: 'link',
  // No PasswordBox control type exists; IsPassword promotes 'textbox' → 'password'.
  edit: 'textbox',
  // RichEdit and other multi-line editors report Document, and they are typed into.
  document: 'textbox',
  combobox: 'combobox',
  listitem: 'option',
  checkbox: 'checkbox',
  radiobutton: 'radio',
  tabitem: 'tab',
  menuitem: 'menuitem',
  // Providers use DataItem for both grid rows and grid cells; 'cell' is the safer
  // of the two because resolve.ts treats cell↔text as compatible, so a
  // descriptor recorded here still resolves when another provider version
  // reports the same node as Text.
  dataitem: 'cell',
  treeitem: 'option',
  headeritem: 'columnheader',
  text: 'text',
  // No Heading control type: heading-ness comes from the HeadingLevel property,
  // which a richer element shape would carry.
  image: 'image',
  thumb: 'image',
  tooltip: 'text',
  statusbar: 'text',
  titlebar: 'text',
  // No Alert control type either; a desktop alert is a Text with a LiveSetting,
  // or an OS window — see the modal note in README.md.
  window: 'dialog',
};

/** UIA names arrive as 'Button', 'UIA_ButtonControlTypeId' or 'ControlType.Button' depending on the binding. */
function canonicalize(controlType: string): string {
  return controlType
    .trim()
    .replace(/^UIA_/i, '')
    .replace(/^ControlType[._]/i, '')
    .replace(/ControlTypeId$/i, '')
    .replace(/[^A-Za-z]/g, '')
    .toLowerCase();
}

export function mapUiaControlType(controlType: string): Role {
  return ROLE_BY_CONTROL_TYPE[canonicalize(controlType)] ?? 'unknown';
}

/** Ancestor types whose Name is a region caption a human would read as context. */
const CONTAINER_TYPES = new Set([
  'window', 'pane', 'group', 'table', 'datagrid', 'list', 'tree', 'tab',
]);

/**
 * Ancestor types whose Name acts as the control's caption. The legacy desktop
 * pattern is the web pattern: a static Text sitting next to (or wrapping) the
 * field, with no programmatic association at all.
 */
const LABEL_TYPES = new Set(['text', 'headeritem', 'header', 'dataitem', 'listitem', 'treeitem']);

const clean = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Keep the outermost caption plus the innermost ones: the window title is the
 * most stable context and the tight groups are the discriminating ones, while
 * the Pane chrome stacked in between is provider noise. Order does not affect
 * scoring (pathScore is membership-based), only readability of the artifact.
 */
function cap(names: string[], max: number): string[] {
  if (names.length <= max) return names;
  const first = names[0]!;
  return [first, ...names.slice(names.length - (max - 1))];
}

function pusher(out: string[], max: number) {
  const seen = new Set<string>();
  return (raw: string | undefined): void => {
    const c = clean(raw);
    if (!c || c.length > 140 || out.length >= max) return;
    const key = norm(c);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
}

/**
 * Pure UIA element → Control. Mirrors the web extractor exactly, including
 * leaving `ordinal` at 0: ordinals are a property of the whole observation
 * (position within a frame+container+role+label bucket), so the caller assigns
 * them after collecting every control.
 */
export function controlFromUiaElement(el: UiaElement, frame: string[], refIndex: number): Control {
  const r = el.boundingRectangle;
  const bbox: Box = {
    x: Math.round(r.left),
    y: Math.round(r.top),
    // Off-screen and collapsed elements report inverted or zeroed rects.
    w: Math.max(0, Math.round(r.right - r.left)),
    h: Math.max(0, Math.round(r.bottom - r.top)),
  };

  const labels: string[] = [];
  const pushLabel = pusher(labels, 5);
  pushLabel(el.name);
  pushLabel(el.helpText);
  // Nearest label-ish ancestor, innermost first — the analogue of the caption
  // cell to the left. A real driver also walks preceding siblings via
  // TreeWalker; the flattened element shape only carries the parent chain.
  for (const a of el.ancestors) {
    if (LABEL_TYPES.has(canonicalize(a.controlType)) && clean(a.name)) { pushLabel(a.name); break; }
  }

  const containers: string[] = [];
  const pushContainer = pusher(containers, 12);
  for (const a of el.ancestors) {
    if (CONTAINER_TYPES.has(canonicalize(a.controlType))) pushContainer(a.name);
  }
  containers.reverse();

  const value = clean(el.value);
  return {
    ref: `u${refIndex}`,
    role: mapUiaControlType(el.controlType),
    name: clean(el.name),
    labels,
    value: value || undefined,
    container: cap(containers, 4),
    frame,
    ordinal: 0,
    enabled: el.isEnabled,
    bbox,
    hint: { tag: clean(el.className) || undefined, attrName: clean(el.automationId) || undefined },
  };
}

export interface UiaSurfaceOptions {
  /** Root of the automation tree: an already-running process, or a command to start one. */
  attachTo?: { processId: number } | { windowTitle: string } | { launch: string; args: string[] };
  /** Path to the observe/act sidecar exposing the JSON-RPC protocol (see README.md). */
  sidecarPath?: string;
  defaultTimeoutMs?: number;
}

/**
 * Every method carries the signature it will have and throws. The stub is the
 * deliverable: it type-checks against Surface today, so the seam is proven
 * rather than asserted.
 */
export class UiaSurface implements Surface {
  readonly kind = 'desktop' as const;

  constructor(private readonly opts: UiaSurfaceOptions = {}) {}

  static async launch(_opts: UiaSurfaceOptions): Promise<UiaSurface> {
    throw new SurfaceError(
      'desktop surface not implemented: spawn the UIA sidecar, attach to the target process or window, and wait for its first automation tree',
    );
  }

  private unimplemented(what: string): never {
    const root = this.opts.attachTo ? JSON.stringify(this.opts.attachTo) : '(no root configured)';
    throw new SurfaceError(`desktop surface not implemented: ${what} [root=${root}]`);
  }

  async observe(): Promise<Observation> {
    // Would walk the control view of the tree under the attached window with a
    // raw-view fallback for providers that hide their leaves, map each element
    // through controlFromUiaElement, then assign ordinals and fingerprint the
    // result exactly as the web surface does.
    return this.unimplemented(
      'walk the UIA control tree, map each element through controlFromUiaElement, assign ordinals and fingerprint the observation',
    );
  }

  async navigate(locus: string): Promise<void> {
    return this.unimplemented(
      `focus or activate the window identified by "${locus}" — a desktop locus is a window/process identity, not a URL, so there is no address bar to type into`,
    );
  }

  async click(ref: string): Promise<void> {
    return this.unimplemented(
      `invoke ref "${ref}" via InvokePattern/TogglePattern/SelectionItemPattern, falling back to a synthesized click at the element's clickable point`,
    );
  }

  async type(ref: string, text: string, opts: TypeOptions): Promise<void> {
    return this.unimplemented(
      `set ref "${ref}" to ${text.length} chars via ValuePattern${opts.clearFirst ? ' after clearing' : ''}, or SetFocus plus synthesized keystrokes when the provider is read-only over ValuePattern${opts.pressEnter ? ', then send Enter' : ''}`,
    );
  }

  async select(ref: string, value: string): Promise<void> {
    return this.unimplemented(
      `expand ref "${ref}" via ExpandCollapsePattern and select the item whose Name is "${value}" via SelectionItemPattern`,
    );
  }

  async press(key: string): Promise<void> {
    return this.unimplemented(`send "${key}" to the focused element of the attached window via SendInput`);
  }

  async answerDialog(decision: 'accept' | 'dismiss'): Promise<void> {
    return this.unimplemented(
      `find the owned modal window of the attached window and invoke its ${decision === 'accept' ? 'default (OK/Yes)' : 'cancel (Cancel/No/close)'} button — desktop modals are separate top-level windows, not page-level events`,
    );
  }

  async screenshot(): Promise<Buffer> {
    return this.unimplemented(
      'capture the attached window with PrintWindow (so occluding windows are excluded) and return a PNG whose origin matches the window rect used to normalize bboxes',
    );
  }

  async sourceSnapshot(): Promise<string> {
    return this.unimplemented(
      'serialize the UIA subtree (control type, name, automation id, patterns, rect) as evidence — there is no DOM, so the tree dump plus the screenshot is the whole record',
    );
  }

  currentLocus(): string {
    return this.unimplemented('report the attached window identity as process:pid/class/title');
  }

  async close(): Promise<void> {
    return this.unimplemented('release cached element pointers and stop the sidecar (never kill an operator-owned application process)');
  }

  operator = {
    click: async (x: number, y: number): Promise<void> =>
      this.unimplemented(`SendInput a click at window-relative (${x},${y}) translated into screen coordinates`),
    typeText: async (text: string): Promise<void> =>
      this.unimplemented(`SendInput ${text.length} chars of unicode keystrokes into the focused window`),
    key: async (key: string): Promise<void> => this.unimplemented(`SendInput the key chord "${key}"`),
    scroll: async (dx: number, dy: number): Promise<void> =>
      this.unimplemented(`SendInput a wheel event of (${dx},${dy}) over the element under the cursor`),
  };
}
