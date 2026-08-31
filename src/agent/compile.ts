/**
 * Recording → capability.
 *
 * The compiler is deliberately separate from the discovery loop and consults no
 * model: given the same recording it produces the same artifact. It is also
 * where the recording is *audited* before it becomes a callable capability.
 *
 * Three audits do most of the work:
 *
 *  1. **Checkpoints must discriminate.** A condition that already held *before*
 *     the action cannot prove the action worked. The planner's stated
 *     expectation is tested against the before/after screens and rejected if it
 *     was already true, was never true, or turned out to be prose rather than
 *     screen text. Rejected candidates fall through to conditions derived from
 *     what actually changed.
 *  2. **Nothing volatile is baked in.** Discovery parameter values are rewritten
 *     to `{{param}}` tokens, and any pattern still carrying a *data* value (a
 *     balance, a name — anything the run extracted as an output) is dropped: it
 *     would make the capability replayable for exactly one member.
 *  3. **Nothing regulated is persisted.** A typed literal that trips the
 *     redactor is a hard compile error, because that value would otherwise be
 *     committed to a repository.
 */
import {
  Capability, CapabilityInput, CapabilityOutput, Predicate, SCHEMA_CAPABILITY, Step, zCapability,
} from '../core/artifact.js';
import { interpolate, interpolateTarget } from '../core/predicate.js';
import { resolveTarget } from '../core/resolve.js';
import type { Redactor } from '../policy/redact.js';
import type { TargetDescriptor } from '../core/target.js';
import type { DiscoverOutcome, OutputProposal, RecordedAction, StateSnapshot } from './discover.js';
import { escapeRe } from './discover.js';
import type { GoalSpec } from './goal.js';

export interface CompileRequest {
  spec: GoalSpec;
  outcome: DiscoverOutcome;
  provenance: { runId: string; plannerProvider: string; model: string; discoveredAt: string };
  redactor: Redactor;
  /** Bumped when re-recording an existing capability. */
  version?: number;
}

export interface CompileResult {
  capability: Capability;
  warnings: string[];
}

export class CompileError extends Error {
  constructor(message: string) { super(message); this.name = 'CompileError'; }
}

/** Everything the audits need to judge a candidate predicate. */
interface Audit {
  /** Discovery parameter values, for interpolating a pattern back to concrete text. */
  values: Record<string, string>;
  /** value → `{{param}}` rewrites, longest first so a substring cannot win. */
  rewrites: Array<{ value: string; token: string }>;
  /** Sampled output values: data, never structure. */
  volatile: string[];
  /** role+caption pairs present on the settled home screen — permanent chrome. */
  chrome: Set<string>;
  warnings: string[];
}

export function compileCapability(req: CompileRequest): CompileResult {
  const { spec, outcome } = req;
  const warnings: string[] = [];

  const audit: Audit = {
    values: Object.fromEntries(spec.params.map((p) => [p.name, p.value])),
    rewrites: [...spec.params]
      .sort((a, b) => b.value.length - a.value.length)
      .map((p) => ({ value: p.value, token: `{{${p.name}}}` })),
    volatile: outcome.outputs
      .map((o) => o.sampleValue)
      .filter((v): v is string => !!v && v.length >= 3)
      .filter((v) => !spec.params.some((p) => p.value === v)),
    chrome: new Set(outcome.chromeKeys),
    warnings,
  };

  const steps: Step[] = [];
  for (const [i, rec] of outcome.recorded.entries()) {
    if (rec.humanAssisted) {
      // A human did something we cannot express as a step. Recording a fake step
      // would make the artifact silently unreplayable; a gap marker keeps it
      // honest and forces review.
      warnings.push(
        `action ${i + 1} was performed by a human operator ("${rec.intent}") and is NOT represented as a replayable step; ` +
        `the capability cannot replay unattended until a reviewer supplies it`,
      );
      continue;
    }
    steps.push(toStep(`s${steps.length + 1}`, rec, spec, req.redactor, audit));
  }

  if (steps.length === 0) throw new CompileError('recording contains no replayable steps');

  const inputs: CapabilityInput[] = spec.params.map((p) => ({
    name: p.name, type: p.type, required: p.required, description: p.description,
    sensitivity: p.sensitivity, pattern: p.pattern, example: p.example,
  }));

  // Outputs are sanitised before anything else consumes them, so the success
  // condition and the contract share one record-independent locator per value.
  const sanitized: OutputProposal[] = outcome.outputs.map((o) => ({
    ...o,
    descriptor: o.descriptor
      ? sanitizeDescriptor(o.descriptor, outcome.finalObservation, audit, `output "${o.name}"`)
      : undefined,
  }));
  const outputs = sanitized.map((o) => toOutput(o, warnings));
  if (outputs.length === 0) warnings.push('capability declares no outputs; callers get success/failure only');

  const successCondition = buildSuccessCondition({ ...outcome, outputs: sanitized }, steps, audit);

  const capability: Capability = {
    kind: 'capability',
    schemaVersion: SCHEMA_CAPABILITY,
    id: `cap_${spec.name}`,
    name: spec.name,
    version: req.version ?? 1,
    title: spec.title,
    description: `${spec.goal} (recorded against ${spec.productId} variant "${spec.variant}")`,
    app: {
      productId: spec.productId,
      variant: spec.variant,
      surface: spec.surface,
      entry: spec.entry,
      profile: spec.profile,
    },
    contract: { inputs, outputs },
    steps,
    successCondition,
    // The exceptional-state vocabulary is a property of the application, not of
    // one happy-path recording: it lives in the shared app profile and is merged
    // at replay time. Capability-specific rules are added by a reviewer.
    outcomes: [],
    recovery: [],
    faults: [],
    policy: {
      maxDurationMs: spec.policy.maxDurationMs,
      // A run that needed a human is never promoted to unattended by the compiler.
      allowUnattended: spec.policy.allowUnattended && outcome.humanAssisted.length === 0,
      requiresConfirmation: spec.policy.requiresConfirmation,
    },
    provenance: {
      discoveredBy: req.provenance.model,
      plannerProvider: req.provenance.plannerProvider,
      runId: req.provenance.runId,
      discoveredAt: req.provenance.discoveredAt,
      entryFingerprint: outcome.entryFingerprint,
      llmSteps: outcome.llmCalls,
      humanAssistedSteps: outcome.humanAssisted,
      promptVersion: 'discovery/v1',
    },
    approval: {
      state: 'draft',
      note: outcome.humanAssisted.length > 0
        ? 'discovery required human intervention; review the recorded gap before approving'
        : 'awaiting review',
    },
    stability: { replays: 0, successes: 0 },
  };

  // Parse through the schema so a compiler bug fails here rather than at replay.
  return { capability: zCapability.parse(capability), warnings };
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

function toStep(id: string, rec: RecordedAction, spec: GoalSpec, redactor: Redactor, audit: Audit): Step {
  const target = rec.descriptor;
  // Step targets are reported but never rewritten: there is no observation here
  // to re-verify a leaner locator against, and silently weakening one that
  // demonstrably worked would be worse than flagging it.
  if (target) {
    const dataLabels = target.labels.filter((l) => isDataValue(l, audit));
    if (dataLabels.length > 0) {
      audit.warnings.push(
        `step ${id}: target is corroborated by data value(s) [${dataLabels.join(', ')}] and may only resolve for the recorded record`,
      );
    }
  }
  const base = {
    id,
    intent: rec.intent,
    risk: rec.risk,
    checkpoint: buildCheckpoint(id, rec, audit),
    // Navigations and posts on a legacy app can take seconds; polled, not slept.
    timeoutMs: rec.kind === 'navigate' || rec.kind === 'dialog' ? 15_000 : 10_000,
    // An irreversible action (a POST, a dialog answering it) must run AT MOST
    // ONCE per invocation: retrying it on a checkpoint failure would re-submit
    // a transaction or re-answer a dialog that no longer exists. If its
    // checkpoint does not hold, that is reported (or escalated) as-is rather
    // than risking a double action.
    retries: rec.risk === 'irreversible' ? 0 : 1,
    optional: false,
  };

  switch (rec.kind) {
    case 'navigate':
      return { ...base, action: { kind: 'navigate', locus: parameterize(rec.locus ?? spec.entry, audit) } };
    case 'press':
      return { ...base, action: { kind: 'press', key: rec.key ?? 'Enter' } };
    case 'dialog':
      return { ...base, action: { kind: 'dialog', decision: rec.decision ?? 'dismiss' } };
    case 'click':
      return { ...base, action: { kind: 'click', target: requireTarget(target, id, rec.kind) } };
    case 'select':
      return {
        ...base,
        action: {
          kind: 'select',
          target: requireTarget(target, id, rec.kind),
          value: { kind: 'literal', value: parameterize(rec.value ?? '', audit) },
        },
      };
    case 'type': {
      const src = rec.text;
      if (!src) throw new CompileError(`step ${id}: type action with no text source`);
      if (src.kind === 'literal') {
        if (redactor.wouldRedact(src.value)) {
          throw new CompileError(
            `step ${id}: refusing to compile a literal that matches a sensitive-data pattern; ` +
            `declare it as a typed parameter instead`,
          );
        }
        if (spec.params.some((p) => p.value === src.value)) {
          throw new CompileError(`step ${id}: literal equals a discovery parameter value and must be recorded as a parameter`);
        }
      }
      return {
        ...base,
        action: {
          kind: 'type',
          target: requireTarget(target, id, rec.kind),
          text: src.kind === 'param' ? { kind: 'param', param: src.param } : { kind: 'literal', value: src.value },
          clearFirst: true,
          pressEnter: rec.pressEnter ?? false,
        },
      };
    }
  }
}

function requireTarget(t: TargetDescriptor | undefined, id: string, kind: string): TargetDescriptor {
  if (!t) throw new CompileError(`step ${id}: ${kind} recorded without a verified target descriptor`);
  return t;
}

// ---------------------------------------------------------------------------
// the checkpoint audit
// ---------------------------------------------------------------------------

const parameterize = (s: string, audit: Audit): string => {
  let out = s;
  for (const { value, token } of audit.rewrites) {
    if (value.length >= 2) out = out.split(value).join(token);
  }
  return out;
};

const holds = (pattern: string, snapshot: StateSnapshot, audit: Audit): boolean => {
  try { return new RegExp(interpolate(pattern, audit.values), 'i').test(snapshot.text); } catch { return false; }
};

const carriesVolatile = (raw: string, audit: Audit): string | undefined =>
  audit.volatile.find((v) => raw.includes(v));

/**
 * Is this string the record's *data* rather than the screen's *structure*?
 * Data-corroborated locators are the subtlest way a recording ends up working
 * for exactly one member: a checkpoint asserting the cell "WHITFIELD, DANA R"
 * passes on the recording and fails on every other lookup.
 */
function isDataValue(text: string, audit: Audit): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (Object.values(audit.values).some((v) => v.length >= 2 && t.includes(v))) return true;
  if (audit.volatile.some((v) => t.includes(v))) return true;
  // A caption is a word; a bare number, amount or date is a value. Captions in
  // these screens are alphabetic and often end in ':'.
  return /^[\d.,\-/$ ]+$/.test(t);
}

/**
 * Roles ordered by how well they identify a *screen* rather than a record.
 * A button or column header is part of the layout; a cell usually holds data.
 */
const CAPTION_ROLE_RANK: Record<string, number> = {
  button: 0, link: 1, columnheader: 2, heading: 3, alert: 4, cell: 5, text: 6,
};

/**
 * Title-bar chrome common to legacy banking screens follows "{INSTITUTION} |
 * {SCREEN TITLE}" — the institution half is exactly what a tenant overlay's
 * branding differs on (Section 3.7's "branded... differently"), so a compound
 * caption baked whole into a checkpoint would tie the capability to the
 * recording tenant more tightly than any individual field caption does. Where
 * the leading half is already known chrome (it appears as a prefix on some
 * caption seen at the settled home screen — the title bar is present on every
 * screen, tenant-branded but otherwise constant), only the trailing, genuinely
 * screen-specific half is kept.
 */
function stripChromePrefix(caption: string, chromePrefixes: Set<string>): string {
  const i = caption.indexOf(' | ');
  if (i < 0) return caption;
  const prefix = caption.slice(0, i);
  return chromePrefixes.has(prefix) ? caption.slice(i + 3) : caption;
}

function chromePrefixesOf(chrome: Set<string>): Set<string> {
  const prefixes = new Set<string>();
  for (const key of chrome) {
    const i = key.indexOf(' | ');
    if (i >= 0) prefixes.add(key.slice(key.indexOf('') + 1, i));
  }
  return prefixes;
}

/** Controls visible after the action that were not visible before it. */
function appeared(rec: RecordedAction, audit: Audit): Array<{ role: string; caption: string }> {
  const before = new Set(rec.before.keys);
  const SEP = '';
  const chromePrefixes = chromePrefixesOf(audit.chrome);
  return rec.after.keys
    .filter((k) => !before.has(k))
    .map((k) => {
      const i = k.indexOf(SEP);
      return { role: k.slice(0, i), caption: k.slice(i + 1) };
    })
    .filter((c) => c.caption.length >= 3 && c.role in CAPTION_ROLE_RANK && !isDataValue(c.caption, audit))
    // A control present on the settled home screen is permanent chrome (a
    // frameset's nav links, the app header) — it "appears new" only because the
    // prior snapshot was the dialog-blocked empty observation, not because
    // anything on the real screen changed.
    .filter((c) => !audit.chrome.has(`${c.role}${SEP}${c.caption}`))
    .map((c) => ({ ...c, caption: stripChromePrefix(c.caption, chromePrefixes) }))
    .filter((c) => c.caption.length >= 3)
    .sort((a, b) => {
      const r = CAPTION_ROLE_RANK[a.role]! - CAPTION_ROLE_RANK[b.role]!;
      return r !== 0 ? r : b.caption.length - a.caption.length;
    });
}

/**
 * Neutralize data in a recorded descriptor's corroborating labels, then confirm
 * the result still resolves to the same control against the observation it was
 * recorded from. Two neutralizations are tried, best first:
 *
 *   1. parameterize — a label equal to a discovery parameter's value becomes
 *      `{{param}}`. This is strictly better than dropping: the corroboration is
 *      kept (the sub-account confirmation cell stays anchored to "MBR NO:
 *      {{memberId}}") and it is genuinely reusable, because interpolateTarget()
 *      substitutes labels at replay time, not just names.
 *   2. drop — for a value that isn't a declared parameter (a sampled output,
 *      an incidental number), there is nothing to substitute, so the label is
 *      removed instead.
 *
 * If neither survives re-verification, the original is kept and the brittleness
 * is reported rather than hidden.
 */
function sanitizeDescriptor(
  d: TargetDescriptor, obs: import('../core/target.js').Observation | undefined, audit: Audit, what: string,
): TargetDescriptor {
  if (!d.labels.some((l) => isDataValue(l, audit))) return d;

  const dataLabels = d.labels.filter((l) => isDataValue(l, audit));
  const parameterized: TargetDescriptor = { ...d, labels: d.labels.map((l) => parameterize(l, audit)) };
  const dropped: TargetDescriptor = { ...d, labels: d.labels.filter((l) => !isDataValue(l, audit)) };

  const sameControl = (candidate: TargetDescriptor): boolean => {
    if (!obs) return false;
    const before = resolveTarget(obs, d);
    // A parameterized label must be re-substituted with the recorded value to
    // compare against the observation it was recorded from — the observation
    // still shows the literal member number, not the token.
    const after = resolveTarget(obs, interpolateTarget(candidate, audit.values));
    return before.status === 'resolved' && after.status === 'resolved' && before.control.ref === after.control.ref;
  };

  if (parameterized.labels.some((l, i) => l !== d.labels[i]) && sameControl(parameterized)) {
    audit.warnings.push(`${what}: parameterized label(s) [${dataLabels.join(', ')}] — locator re-verified and remains reusable`);
    return parameterized;
  }
  if (dropped.labels.length !== d.labels.length && sameControl(dropped)) {
    audit.warnings.push(`${what}: dropped data-valued label(s) [${dataLabels.join(', ')}]; locator re-verified without them`);
    return dropped;
  }
  audit.warnings.push(
    `${what}: keeping data-valued label(s) [${dataLabels.join(', ')}] because neutralizing them changes which control is found — ` +
    `this locator is record-specific and needs a reviewer`,
  );
  return d;
}

const presenceOf = (role: string, caption: string): Predicate => ({
  kind: 'controlPresent',
  target: {
    role: role as TargetDescriptor['role'],
    name: { value: caption, mode: 'exact', alternatives: [] },
    labels: [], container: [], frame: [], minScore: 0.55, minMargin: 0.08,
  },
});

function buildCheckpoint(id: string, rec: RecordedAction, audit: Audit): Predicate | undefined {
  const preds: Predicate[] = [];

  // 1. What the planner said it expected — kept only if it actually discriminates.
  const raw = rec.expectAfter?.trim();
  if (raw && raw.length >= 3) {
    const volatile = carriesVolatile(raw, audit);
    const pattern = parameterize(escapeRe(raw), audit);
    if (volatile) {
      audit.warnings.push(
        `step ${id}: dropped the planner's expectation because it embeds the data value "${volatile}" — ` +
        `that would make the capability replayable for one record only`,
      );
    } else if (!holds(pattern, rec.after, audit)) {
      audit.warnings.push(`step ${id}: dropped the planner's expectation ("${raw.slice(0, 60)}") — it was not literal screen text`);
    } else if (holds(pattern, rec.before, audit)) {
      audit.warnings.push(`step ${id}: dropped the planner's expectation ("${raw.slice(0, 60)}") — it was already true before the action`);
    } else {
      preds.push({ kind: 'textMatches', pattern });
    }
  }

  // 2. For a keystroke into a field that stays on screen, the precise
  //    post-condition is that the field now holds what we typed.
  if (rec.kind === 'type' && rec.descriptor && !rec.pressEnter && rec.text) {
    const key = `${rec.descriptor.role}\u001f${(rec.descriptor.name?.value ?? '').toUpperCase()}`;
    if (rec.after.keys.includes(key)) {
      const expected = rec.text.kind === 'param' ? `{{${rec.text.param}}}` : escapeRe(rec.text.value);
      preds.push({ kind: 'controlValueMatches', target: rec.descriptor, pattern: `^${expected}$` });
    }
  }

  // 3. Something new on screen is direct evidence the action landed.
  //    'cell' captions are data-grid content: nameScore() also matches a
  //    caption against a NEIGHBOURING cell's inferred label (that is what
  //    makes label-based field lookup work), which means a bare-name
  //    controlPresent on a plain caption can resolve equally well to the
  //    caption cell itself and to the value cell it labels — genuine
  //    ambiguity, not a flake. Landmark roles (button/link/heading/
  //    columnheader/alert) do not have that failure mode, so only those get
  //    an element-presence assertion; a 'cell' caption falls back to a text
  //    search, which has no element to disambiguate and so cannot tie.
  if (preds.length === 0) {
    const news = appeared(rec, audit);
    const landmarks = news.filter((c) => c.role !== 'cell' && c.role !== 'text');
    const picks = (landmarks.length > 0 ? landmarks : news).slice(0, 2);
    for (const c of picks) {
      preds.push(
        c.role === 'cell' || c.role === 'text'
          ? { kind: 'textMatches', pattern: escapeRe(parameterize(c.caption, audit)) }
          : presenceOf(c.role, parameterize(c.caption, audit)),
      );
    }
    if (picks.length > 0) {
      audit.warnings.push(`step ${id}: checkpoint derived from controls that appeared after the action`);
    }
  }

  // 4. A locus change, when there is one. Frameset apps rarely change the top URL,
  //    so an all-matching "/" pattern is worse than no clause at all.
  const beforePath = pathOf(rec.before.locus);
  const afterPath = pathOf(rec.after.locus);
  if (afterPath && afterPath !== '/' && beforePath !== afterPath) {
    preds.push({ kind: 'locusMatches', pattern: escapeRe(parameterize(afterPath, audit)) + '(\\?|$)' });
  }

  // 5. A click that raised a native modal (the irreversible-post confirm())
  //    has its real post-condition here: a dialog is now blocking the page.
  //    Checked before the "no checkpoint" fallback below, since it is a
  //    stronger and more literal signal than anything text-derived.
  if (!rec.before.dialog && rec.after.dialog && preds.length === 0) {
    preds.push({ kind: 'dialogPresent' });
  }

  // 6. Whatever else changed, a modal we answered must be gone.
  if (rec.kind === 'dialog') preds.push({ kind: 'not', of: { kind: 'dialogPresent' } });

  if (preds.length === 0) {
    audit.warnings.push(`step ${id} has NO checkpoint: replay cannot verify that "${rec.intent.slice(0, 60)}" took effect`);
    return undefined;
  }
  return preds.length === 1 ? preds[0]! : { kind: 'all', of: preds };
}

/**
 * Success is asserted independently of the per-step checkpoints. The strongest
 * derived form is "the screen contains the things this capability promised to
 * return" — if the outputs are all present, we are demonstrably on the right
 * screen, whatever their values happen to be.
 */
function buildSuccessCondition(outcome: DiscoverOutcome, steps: Step[], audit: Audit): Predicate {
  const preds: Predicate[] = [];
  const final = outcome.recorded[outcome.recorded.length - 1]?.after;

  const raw = outcome.successText?.trim();
  if (raw && raw.length >= 3 && final) {
    const volatile = carriesVolatile(raw, audit);
    const pattern = parameterize(escapeRe(raw), audit);
    if (volatile) {
      audit.warnings.push(`dropped the planner's success text because it embeds the data value "${volatile}"`);
    } else if (!holds(pattern, final, audit)) {
      audit.warnings.push(`dropped the planner's success text ("${raw.slice(0, 60)}") — it was not literal screen text`);
    } else {
      preds.push({ kind: 'textMatches', pattern });
    }
  }

  for (const o of outcome.outputs) {
    if (!o.verified || !o.descriptor) continue;
    preds.push({ kind: 'controlPresent', target: o.descriptor });
    if (preds.length >= 3) break;
  }

  if (preds.length === 0) {
    const fallback = steps[steps.length - 1]?.checkpoint;
    if (fallback) {
      audit.warnings.push('no independent success condition could be derived; reusing the final step checkpoint');
      return fallback;
    }
    audit.warnings.push('NO success condition could be derived: replay will report success on step completion alone');
    return { kind: 'titleMatches', pattern: '.' };
  }
  return preds.length === 1 ? preds[0]! : { kind: 'all', of: preds };
}

// ---------------------------------------------------------------------------
// outputs
// ---------------------------------------------------------------------------

/** A blank description defeats the schema's own purpose (a reviewer/agent contract); backstop it. */
function describeOutput(o: OutputProposal): string {
  if (o.description.trim()) return o.description.trim();
  return `Value read from the ${o.descriptor ? `"${o.descriptor.name?.value ?? o.descriptor.labels[0] ?? o.name}"` : 'page'} field/cell (auto-generated: the discovery run did not supply a description).`;
}

function toOutput(o: OutputProposal, warnings: string[]): CapabilityOutput {
  const transform: CapabilityOutput['transform'] =
    o.type === 'money' || o.type === 'number' ? ['trim', 'money']
      : o.type === 'integer' ? ['trim', 'digits']
        : ['trim', 'collapseSpace'];

  if (!o.verified) {
    warnings.push(`output "${o.name}" did not extract at record time (${o.rationale}); it is declared required and will fail replay`);
  }

  if (o.descriptor) {
    const isField = ['textbox', 'password', 'combobox'].includes(o.descriptor.role);
    return {
      name: o.name, type: o.type, description: o.description, sensitivity: o.sensitivity, required: true,
      source: isField
        ? { kind: 'controlValue', target: o.descriptor }
        : { kind: 'controlText', target: o.descriptor },
      transform,
    };
  }
  warnings.push(`output "${o.name}" falls back to a page-text regex; a control-based locator would be more robust`);
  return {
    name: o.name, type: o.type, description: o.description, sensitivity: o.sensitivity, required: true,
    source: { kind: 'pageRegex', pattern: o.regex ?? `${escapeRe(o.name)}\\s*[:#]?\\s*([^\\n]+)`, group: 1 },
    transform,
  };
}

function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return ''; }
}
