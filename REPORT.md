# Design Report

## 1. Architecture

A single TypeScript/Node process with two runtime paths sharing one core:

```
discover: goal ──▶ Session.observe() ─▶ Planner.decide() [LLM] ─▶ Session.act() ─▶ compile()
                         ▲                                              │
                         └──────────────── loop ───────────────────────┘
                                                                          ▼
                                                                     Capability (JSON)
replay:   inputs ──▶ ReplayEngine ─▶ resolveTarget() / evaluate() ─▶ Session.act()  [no LLM]
```

`src/core/` (`target.ts`, `resolve.ts`, `predicate.ts`, `artifact.ts`) has no dependency
on Playwright, the model, or the filesystem — it is the vocabulary both paths speak.
`src/surface/surface.ts` is the one seam between that vocabulary and a real UI; `WebSurface`
is the only implementation exercised, but the type itself is surface-agnostic (§4).
`Session` (`src/session/session.ts`) is the single choke point every action — discovery
or replay — passes through: it is where the policy gate, the control lease, and the
journal all live, so there is exactly one place to audit "what is the automation allowed
to do right now." `Planner` (`src/agent/planner.ts`) is the only thing that can call a
model; the replay engine never imports it, which makes "no model in the loop on replay" a
type-level property, not a promise.

Key trade-offs:
- **Single process, synchronous CLI, no queue.** Hundreds of tenants × ~20 apps implies a
  fleet eventually, but building that queue for a take-home would be exactly the
  "scaling infrastructure" the brief says not to build. What has to be real is the
  *interface* a queued worker would call (`replay()`, `discover()`, the `Session`/`Journal`
  contract) — those don't change if a queue is added in front of them.
- **Compiler separated from the discovery loop.** `discover()` produces a
  `DiscoverOutcome` (a recording); `compileCapability()` (`src/agent/compile.ts`) turns
  it into a `Capability` with no model call. This means the artifact-hardening logic —
  checkpoint discrimination, parameterization, redaction — is deterministic, testable,
  and rerunnable without spending another LLM call.
- **App profile vs. capability.** Exceptional-state rules split into a shared
  `AppProfile` (per vendor product: sign-on, session expiry, maintenance notices, generic
  app errors — `app-profiles/meridian-core.json`) and capability-specific `outcomes` (a
  particular error code this flow can produce). One profile serves every capability
  recorded against that product; see §4.

## 2. Artifact schema

A `Capability` (`src/core/artifact.ts`) is a **contract**, not a script:

```
contract: { inputs: CapabilityInput[], outputs: CapabilityOutput[] }
steps: Step[]                    // ordered actions, each with a risk class + checkpoint
successCondition: Predicate
outcomes / recovery / faults: Rule[]   // the three-way error taxonomy — see §3
policy: { maxDurationMs, allowUnattended, requiresConfirmation }
provenance: { discoveredBy, runId, entryFingerprint, humanAssistedSteps, ... }
approval: { state: draft|approved|revoked, by, at }
stability: { replays, successes, successRate }
```

Two design choices carry most of the weight:

**Locators are semantic, not structural.** A `TargetDescriptor` is `role + accessible
name + inferred captions ("labels") + frame path + container + ordinal`, scored by
`resolve.ts`'s `resolveTarget()` — never a CSS selector or XPath. The target app
randomizes every element id on every render specifically to make that the only viable
strategy; `test/resolve.test.ts` asserts two observations of the same screen with
different ids resolve to the same control. A resolution below `minScore` is
`not_found`; two candidates within `minMargin` of each other is `ambiguous` — the
resolver never guesses (§3).

**The error taxonomy is three separate rule lists, not a severity field.** `outcomes`
(a legitimate business answer — "no such member"), `recovery` (a condition the replay
clears itself — session expiry), and `faults` (a hard failure, optionally escalated) are
structurally distinct types in the schema. That makes "no such member" and "the
automation broke" impossible to conflate by construction, which the brief calls out as
the most common design mistake here.

Everything else follows the same target vocabulary: `CapabilityOutput.source` is
`controlText | controlValue | pageRegex`, so extracting a balance uses the identical
locator machinery as clicking a button. A step's `checkpoint` and the capability's
`successCondition` are both `Predicate`s — `controlPresent`, `controlValueMatches`,
`textMatches`, `dialogPresent`, composed with `all/any/not` — so "did this work" is
asserted the same way everywhere, never assumed from "the click didn't throw."

## 3. Determinism & error handling

Replay (`src/replay/engine.ts`) makes no decision the artifact didn't already encode:

- **Resolution is a pure, total-order function** of `(Observation, TargetDescriptor)`.
  Same inputs → same control, every time; ties are broken by frame/ordinal/position, not
  iteration order, so shuffling the DOM's control list doesn't change the answer
  (`test/resolve.test.ts`).
- **Progress is polled, never slept.** `pollPredicate()` re-observes every 200ms until a
  checkpoint holds or its timeout expires — a slow page waits exactly as long as it needs
  to; a wrong page fails on evidence, not on a guessed delay.
- **Classification runs before *and* after every step**, in a fixed order — faults, then
  recovery, then outcomes (`src/replay/monitors.ts`) — so an application-error page is
  never misread as "no records" (fault matched first) and a session-expiry screen is
  cleared before anything on it is trusted.
- **Recoveries are bounded and counted per rule code** (`RecoveryLedger`); a condition
  that keeps recurring becomes `RECOVERY_EXHAUSTED`, not an infinite loop.
- **An `irreversible` step gets zero retries** (`compile.ts`: `retries: rec.risk ===
  'irreversible' ? 0 : 1`). This was a real bug I hit and fixed during development: an
  early build retried a failed checkpoint after a dialog-accept and tried to re-answer a
  dialog that no longer existed — on a real POST that shape of bug double-submits a
  transaction. A non-idempotent action now runs at most once per invocation; if its
  checkpoint doesn't hold, that's reported (or escalated), never silently repeated.
- **Structural drift is a warning, not a gate.** Each capability records an
  `entryFingerprint` (a hash of role+caption shape, ignoring values); replay compares it
  and logs a `drift` event on mismatch but proceeds on the semantic locators — the entire
  point of not using structural selectors is that a reshaped screen is still drivable.

The compiler audits every checkpoint before it ships, catching what a naive
record-replay tool would silently get wrong: a candidate condition already true
*before* the action doesn't discriminate (dropped); a checkpoint text containing a
sampled data value ("4,812.63 for Dana") would pin the capability to one record
(dropped, or parameterized to `{{memberId}}` and re-verified — see `sanitizeDescriptor`);
and — a bug I found by testing against a real frameset — a bare `controlPresent` derived
from an "appeared" caption is ambiguous when the role is a data-grid `cell`, because the
same caption also matches as a *neighboring* cell's inferred label; the compiler now
routes cell/text captions to a text-search assertion instead of an element-presence one,
which has no element to tie against. Every dropped/rewritten checkpoint is reported as a
compiler warning, visible in `evidence/discovery-*/`.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** `Surface` (`src/surface/surface.ts`) exposes nine methods —
`observe/navigate/click/type/select/press/answerDialog/screenshot/sourceSnapshot` plus an
`operator.*` input path — and `Observation`/`Control` are the only shapes anything above
it sees. `WebSurface` computes that from the DOM + accessibility properties (legacy
markup has neither test ids nor labels, so captions are inferred from table geometry:
the cell to the left, the column header above — `src/surface/web/extract.ts`).
`src/surface/desktop/uia-surface.ts` implements the same interface for Windows UI
Automation: its I/O methods are typed stubs, but `mapUiaControlType()` and
`controlFromUiaElement()` are real, tested functions showing that UIA's `ControlType`,
`Name`, `HelpText`, ancestor chain, and `BoundingRectangle` map onto exactly the same
`Control` shape a web page produces — because a `TargetDescriptor` never encodes anything
DOM-specific, the artifact schema and replay engine need zero changes to target a desktop
app. `src/surface/desktop/README.md` covers what genuinely doesn't carry over (no URL, no
DOM snapshot for evidence, OS-level modals) and a documented last-resort path for a
surface with no accessibility tree at all (screenshot + anchor-relative coordinates, with
an explicit confidence penalty — deliberately never the first choice).

**Multi-tenant reuse.** A `Capability` is recorded once, against one `AppProfile`
(shared per vendor product). A `TenantOverlay` (`tenants/riverbend.json`) specializes it
two ways, cheapest first: `labelSynonyms` rewrites captions used anywhere in the
capability (a target's `name`/`alternatives`, and — after a bug I found and fixed —
*labels* too, so a corroborating caption like "MBR NO: {{memberId}}" on a confirmation
screen stays reusable instead of only ever matching the recorded member); per-step
patches handle the rare case where the flow itself differs. The evidence includes the
`lookup_member_savings_balance` capability, recorded once against the `base` tenant,
replayed successfully against `riverbend` — different field captions ("MEMBER NUMBER"
vs. "MBR NO"), different routes, and an extra forced compliance interstitial —
with **zero changes to the capability file itself**. The interstitial needed no overlay
entry at all: it's cleared by the shared `AppProfile`'s `MAINTENANCE_NOTICE` recovery
rule, because it's a property of the *application*, not the caption.

**Drift detection.** The `entryFingerprint` mechanism above doubles as the per-tenant/
version drift signal: an artifact replayed against a tenant whose entry screen shape has
changed logs a structured `drift` event with old/new fingerprints, so a fleet operator
can query "which capabilities have drifted on tenant X" without any capability failing on
it alone.

## 5. Escalation & handoff

**Detecting stuck.** During discovery, the planner can emit `stuck` with a reason.
During replay, five conditions raise an intervention: `TARGET_NOT_FOUND`,
`AMBIGUOUS_TARGET`, `CHECKPOINT_FAILED`, `RECOVERY_EXHAUSTED`, and (for a step whose risk
class the policy marks `confirm`) `CONFIRMATION_REQUIRED`. Each carries the capability,
the step, the redacted screen state, a screenshot, and — critically — `askedFor`: plain-
language instructions for what the operator should actually do.

**Control transfer.** `ControlLease` (`src/session/lease.ts`) tracks one owner
(`automation | operator`) and a monotonic `epoch`. `Session.act()` checks the lease
*before and after* every action — the "after" check is what catches a human taking over
mid-click rather than racing it. Escalating never pre-emptively drops the lease: the
engine publishes an `InterventionRequest` and blocks; control moves only when a human (or
the scripted stand-in, using the identical `surface.operator.click/typeText` input path a
real one uses — never the ref-based action API) actually calls "take control," and moves
back only on an explicit resolution. On handback, the engine re-observes and checks the
step's checkpoint / the capability's success condition before deciding whether to retry
the step or continue past it — it never assumes the human did exactly what was asked.

**The console** (`src/escalation/operator-console.ts`) is a real (if minimal) HTTP
server: it lists open interventions, and its per-intervention page polls the live
screenshot, maps a click on the image to real viewport pixels, and exposes take-control /
type / key / resume / complete-manually / abort actions — all going through the same
`Session`/`ControlLease` machinery replay uses. `--operator-sim` exists so this whole
path is exercisable in an automated evidence run (see `README.md`); it is not a
different code path, just a different decision-maker.

## 6. Safety

`PolicyGate` (`src/policy/policy.ts`) is the single choke point: an allowlist of locus
regexes and permitted action kinds, and a per-risk-class disposition
(`allow | confirm | block`) for `read | write | irreversible`. Every action — discovery
or replay — passes `PolicyGate.check()` inside `Session.act()`; there is no second path
to the surface. `irreversible` defaults to `confirm`: the policy neither blocks banking
work outright nor lets it through unattended, and a capability's own
`requiresConfirmation` list plus its `allowUnattended` flag (never set `true` by the
compiler if discovery needed human help) gate unattended invocation on top.

`Redactor` (`src/policy/redact.ts`) is the one path everything written to disk goes
through — journals, observation snapshots, frame-source dumps, intervention payloads —
combining pattern rules (SSN, PAN, email, JWT, credential assignments) with explicitly
registered values (the target app's password, any input declared `pii`/`secret`, every
extracted output of that sensitivity). The compiler backstops this at record time: a
literal the discovery run tried to type is checked against the redactor before it can be
compiled into an artifact, and refused outright if it matches a sensitive pattern —
regulated data cannot reach a committed capability file even by accident.

**Limits.** There's no RBAC on *who* may invoke a capability or approve one (`--by` is
free text), no secrets vault (credentials are env vars by name only, never values, but
storage security is the deployer's problem), and redaction is pattern- and
registration-based — it will not catch a sensitive value in a shape neither mechanism
anticipates. Approval is a single boolean state with a free-text note, not a workflow.
**Screenshots are not redacted.** The Redactor scrubs strings — journal lines,
observation JSON, frame-source HTML — but a screenshot is raw viewport pixels, so a
value the app renders on screen (a member's SSN on a detail screen, in this project's own
`/evidence/`) is visible in the PNG even though the exact same value is masked everywhere
else that run wrote to disk. Closing this for real means either OCR-and-blur over known
sensitive regions or not persisting screenshots for screens carrying declared-sensitive
fields at all; I did neither, so treat every screenshot in `/evidence/` as the least-
trusted artifact in the directory.

## 7. Cuts

- **No queue/fleet infrastructure.** Deliberately — the brief asks for credible
  abstractions, not built-out scaling plumbing.
- **Desktop and hostile-surface (screenshot+coordinate) drivers are stubbed**, not
  implemented — the abstraction and the mapping functions are real and tested; the I/O
  isn't, since no desktop app was in scope.
- **Operator console has no auth, no multi-operator queueing, no video/co-browsing** —
  the scope note explicitly allows a mock/minimal console as long as the handoff
  mechanism is real, which it is.
- **Two escalations for one logical irreversible decision.** Because the click that
  raises the confirm() dialog and the dialog-accept are both modeled as separate
  `irreversible` steps, an operator can be asked to approve twice for what a person
  would think of as one decision ("open this sub-account"). Correct and conservative,
  but a rough edge — the next iteration would let a capability mark a *run* of steps as
  one confirmable unit.
- **No LLM-assisted replay-time recovery** (a stretch goal) — a replay failure always
  surfaces as `failure` or escalates to a human; it never quietly reaches back into the
  model for one step.
- **Confidence scoring is a raw `stability.successRate`**, not a full gate that blends
  match-score history — good enough to gate unattended promotion, not a real reliability
  model.
- **Canonicalization is manual** (an author writes the overlay); the brief's
  route-templating idea (`/item/12345` → `/item/:id`) isn't automated.

What I'd build next, in order: fold same-transaction irreversible steps into one
confirmable unit; a small confidence model that weights resolver `runnerUp` margins over
time, not just pass/fail; and a real queue/worker split behind the existing
`replay()`/`discover()` functions — which, per the design above, shouldn't need to change
to sit behind one.
