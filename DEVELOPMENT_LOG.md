# Development log: the reasoning path

`REPORT.md` documents the design I ended up with and why it's justified. This document
is the other half: the order I actually worked in, the decisions I made *before* writing
code, and — the part a clean write-up tends to hide — the real bugs I found by testing
against a live browser, how I diagnosed each one, and what I changed as a result. The
brief says the discovery run has to be real and that "you own everything you submit and
must be able to explain and defend any part of it in detail"; this is the record that
lets me do that.

## 1. Reading the brief

Three sentences in Section 1 decided most of the architecture before I wrote a line of
code:

> "The hard part is not constant drift — it's that a replay must accommodate the errors
> and exceptional states that legitimately occur at runtime."
> "Business outcome vs. failure ... is the most common design mistake here."
> "This is intentionally under-specified ... make a decision, and tell us why."

That told me where to spend depth: the artifact schema and the error taxonomy were the
part being graded hardest, not breadth of features. So before touching Playwright I
decided the shape of three things: what a locator *is* (semantic, not structural — the
brief's "no clean DOM, no stable selectors" is explicit about this), what a replay result
*is* (four distinct statuses, not success/failure), and what a capability *is* (a
contract with typed inputs/outputs, not a step list). Everything else — which browser
driver, which LLM SDK, which CLI framework — was a means to exercise those three
decisions, so I picked the boring, well-documented option each time (Playwright, the
official Anthropic SDK, a hand-rolled `argv` parser) rather than spend judgment budget on
it.

## 2. Choosing the target surface

The brief explicitly allows a public demo site, a local app, or "an intentionally hostile
surface." I built the hostile surface (`target-app/`) rather than pointing at a public
site, for a reason that only became obvious once I thought about what the *evaluation*
actually needs to see: a public site can't be made to reliably reproduce a session
timeout, an application error page, a validation failure, or a permission-denied result
on demand, and 3.3 explicitly wants "one replay that hits an error or exceptional state."
I needed fault injection I controlled (`/_fault` in `target-app/server.ts`) to produce
that evidence honestly rather than hoping a real site happened to misbehave during the
recorded run. The same reasoning drove randomizing every element id on every render
(`target-app/render.ts`'s `rid()`) — it's the cheapest way to make "a locator strategy
that doesn't use ids" a tested claim instead of an assumed one, and it directly exercises
the "legacy web app... no test IDs" case from Section 1 rather than the friendlier
"modern web app" case.

The two-tenant setup (`base` / `riverbend` in `target-app/variants.ts`) existed from the
start for the same reason: Section 3.7 asks for a *credible design*, but I wanted at
least one multi-tenant claim to be something I'd actually run, not just argued for in
prose.

## 3. Model provider: building two, not one

The brief requires "at least one genuine LLM-driven run against a live surface... a
single successful run is not an expensive thing to produce," which reads as a low bar —
but I didn't want the one real run to be a bottleneck I couldn't afford to repeat while
iterating on the compiler (which I ended up doing many times, per §5 below). I checked
what credentials were actually available in the environment early (`ant auth status`
equivalent, `ANTHROPIC_API_KEY` — neither set) and found the local `claude` CLI was
already authenticated. Rather than treat that as a blocker, I built `Planner` as a
one-method interface (`src/agent/planner.ts`) with two implementations: `AnthropicPlanner`
for a real `ANTHROPIC_API_KEY` (the production path, strict tool-call schema), and
`ClaudeCliPlanner` driving the CLI headlessly (`--tools ""`, no persona, no session
persistence) as a bare model endpoint with the identical decision schema. I verified the
CLI path actually worked before committing to it as the evidence-producing path — a quick
manual call (`claude -p --output-format json ...`) confirmed ~$0.002–0.03/call and
~6–11s latency, cheap enough to re-run discovery a dozen times while debugging the
compiler without worrying about cost.

## 4. Build order

Core vocabulary first (`src/core/target.ts`, `resolve.ts`, `predicate.ts`,
`artifact.ts`), with no Playwright import anywhere in that directory — I wanted the
resolver and predicate evaluator to be pure functions I could unit-test before a browser
was involved at all, because a locator scoring bug is much cheaper to find against a
hand-built `Observation` fixture than against a live page. Policy and redaction next
(`src/policy/`), because I wanted the guardrail to exist *before* the surface driver did,
so there was never a moment where an action could reach a real page unguarded. Then the
perception layer (`src/surface/web/extract.ts`) and a manual probe script against the
live target app — I did not trust the caption-inference logic (reading a legacy `<td>
CAPTION:</td><td><input></td>` pattern) to work on the first try, and it didn't (§5.1).
Only after perception was verified live did I write the replay engine, then discovery,
then the compiler, then escalation, then the CLI that wires all of it together. I fanned
out the operator console, the unit test suite, and the desktop-surface seam to a
background workflow once the core contracts (`Surface`, `ControlLease`,
`InterventionRequest`, the artifact schema) were stable enough that three people working
from them wouldn't collide — that's a build-order decision too: parallelize only after
the interfaces those parts depend on stop changing.

## 5. Bugs found by testing, and how I found them

This is the part a from-scratch design write-up tends to omit, and it's the part I think
best demonstrates the judgment the brief is asking for — most of these are not "I forgot
something," they're "the design looked right until a real page proved it wasn't."

**5.1 — In-page extractor crashed with `ReferenceError: __name is not defined`.**
First live probe against the frameset. esbuild's `keepNames` transform wraps function
declarations in a `__name()` helper that doesn't exist inside `page.evaluate()`'s
isolated context. Fixed by injecting a no-op shim via `context.addInitScript()` before
the extractor ever runs. This is the kind of bug that only exists because I was
serializing a real TypeScript function into the page rather than hand-writing a JS
string — a trade-off I kept anyway, because a type-checked extractor is worth one init
script.

**5.2 — Perception returned a truthful but useless observation.** The frameset's root
document finishes loading before its child frames do; waiting on
`domcontentloaded` at the top level raced the actual content. Switched to `load` and
added a retry-once path in `WebSurface.observe()` when a sweep comes back with zero
frames or zero controls, and made a *fully* empty sweep (every frame failed to evaluate)
a thrown `SurfaceError` instead of a silently empty `Observation` — the failure mode I
wanted to avoid was a `TARGET_NOT_FOUND` three steps later with no clue why the screen
looked blank.

**5.3 — The planner's own stated checkpoints were not trustworthy verification.** Once
discovery was producing real recordings, I read the first compiled artifact by hand and
noticed step checkpoints and the success condition had literally baked in
`"MEMBER DETAIL screen for MBR 12345 shows REG SAVINGS current balance 4,812.63"` — the
model's prose, including the specific member's data, not a fact about the screen. That
would have replayed successfully exactly once, for exactly that member, and then looked
like a real assertion forever. This is the finding that turned the compiler from "reformat
the recording" into an actual audit: every candidate checkpoint is now tested against the
before/after screen snapshots and dropped unless it (a) was false before the action and
true after, and (b) is literal on-screen text, not a paraphrase. See `REPORT.md` §3.

**5.4 — Caption keys collided on their own delimiter.** The "what's new on screen" diff
(`appeared()` in `compile.ts`) keys controls by `role + caption`. I initially joined
those with `|`, then discovered the target app's own title bar text is
`"FIRST MERIDIAN FCU | MAIN MENU"` — a caption containing the exact delimiter I was
splitting on. Switched to `` (a control character that can never appear in
extracted UI text). Small bug, but the kind that fails silently (wrong split points, not
a crash) and would have been very slow to notice without directly inspecting the derived
checkpoints.

**5.5 — Corroborating labels couldn't carry `{{param}}` tokens.** Testing the
sub-account flow, the compiler reported it had to *keep* a data-pinned locator (the
posting-confirmation cell's label list included the literal recorded member number,
`"23456"`) because dropping it changed which control resolved. I'd already built
parameter substitution for a descriptor's `name` field but never extended it to `labels`
— an oversight that only mattered because the confirmation screen corroborates its
REFERENCE NO. cell with the row above showing the member number, and that corroboration
is exactly the kind of signal I want kept, not thrown away. Fixed by exporting one
`interpolateTarget()` (`src/core/predicate.ts`) that covers `name`, `labels`, and
`container`, and using it everywhere a descriptor is resolved at replay time — and then
teaching the compiler to *try* parameterizing a data-valued label before falling back to
dropping it, re-verifying the parameterized version resolves to the same control before
trusting it.

**5.6 — A replay run hung indefinitely; three false hypotheses before the real one.** The
most involved investigation in the project. Symptom: `replay --confirm` on the
irreversible sub-account flow simply never returned. My first hypothesis was a stale
element handle; ruled out by re-reading the journal, which showed the run had reached the
dialog-accept step and then produced nothing further — not a hang inside an action, a
hang inside something that runs *after* one. Second hypothesis: the checkpoint poll loop
itself; ruled out by tracing `runStepWithRetries` by hand against the journal's own
`checkpoint.fail` event, which showed the poll *did* return (with `ambiguous`, not a
timeout) and control had already moved into `problemToResult()`. Third hypothesis, and
the one that actually panned out on inspection: `problemToResult()` unconditionally calls
`captureFailureEvidence()`, which calls `surface.sourceSnapshot()`, which calls
`frame.content()` on every frame to grab a full HTML dump for debugging — and
`frame.content()` needs to execute JavaScript inside the page. A native `confirm()`
dialog freezes a page's JS execution until it's answered, and I was trying to capture
failure evidence for a state where the confirm dialog was *still open*, waiting on a
human decision that couldn't be made because the evidence-capture that was supposed to
help a human decide was itself blocked on the page it couldn't read. `screenshot()` and
`observe()` already had this exact guard (`if (this.pendingDialog) return ...`);
`sourceSnapshot()` didn't. That inconsistency — one method in a three-method "capture
what you can see" family missing the guard the other two had — is exactly the kind of
thing that's invisible in a design review and only shows up when you actually run the
failure path, which is why I think this was worth writing up in detail rather than just
listing as a line item.

Along the way, root-causing 5.6 required reading raw journal lines, and I noticed
`Journal.event()` spread the caller's `data` object *after* setting the event-type
`kind`, so any event whose payload itself had a `kind` field (`session.act()`'s
`policy.check`/`action` events, which log the *action's* kind) silently overwrote the
event-type discriminator — I was reading `"kind":"dialog"` in the journal and reasonably
concluding that was the event type, when it was actually `policy.check` with a
same-named data field clobbering it. Fixed the spread order once I understood it, but the
process is the point: a hunt for one bug (5.6) surfaced a second, unrelated one (the
journal collision) purely from reading raw evidence closely rather than trusting my own
logging.

**5.7 — Retrying an irreversible action is unsafe on principle, independent of 5.6.**
While fixing the hang above, I realized the underlying retry — re-dispatching a `dialog`
action whose checkpoint failed — was going to try to answer a dialog that had *already
been answered and consumed* on the prior attempt, which is exactly the shape of bug that
double-submits a real transaction. This wasn't something I found by testing so much as
something I noticed was possible while explaining the hang to myself, and decided was
worth fixing regardless of whether it was the hang's actual cause: `retries: 0` for any
step whose `risk` is `irreversible` (`compile.ts`), so a non-idempotent action runs at
most once per invocation, full stop.

**5.8 — Multi-tenant reuse failed on the institution's own name.** Testing the same
artifact against the `riverbend` tenant, the first replay failed with a checkpoint
timeout. The derived checkpoint asserted a title-bar cell reading
`"FIRST MERIDIAN FCU | MEMBER INQUIRY"` — correct on the recording tenant, meaningless on
riverbend, whose institution name is different. The bug wasn't in the *matching* logic,
it was in the *compiler's* choice of what to assert: a title bar's tenant-branding half is
exactly the kind of thing Section 3.7 says varies by tenant, so baking it whole into a
checkpoint was always going to be less portable than an individual field caption. I fixed
this by tracking which captions are visible on the discovery run's settled home screen
("chrome" — the frameset's nav frame and the app's own title-bar convention are present
on every screen, tenant-branded but otherwise constant) and stripping a matched chrome
prefix from any derived checkpoint before using it, so `"{tenant} | MEMBER INQUIRY"`
becomes just `"MEMBER INQUIRY"` when the tenant-name half is already known chrome.

**5.9 — A docstring that overclaimed, caught by looking at my own screenshot.** Found
last, while capturing the README showcase images: `journal.ts` opened with "Everything
written here passes through the Redactor first. There is no second path to disk, which is
what makes 'no regulated data is persisted' auditable rather than aspirational" — and the
member-detail screenshot I was about to publish showed a full (synthetic) SSN in the
clear. Both facts were true; the sentence was still wrong. `Journal.saveScreenshot()`
writes a raw PNG buffer, and the Redactor operates on strings, so screenshots were the one
artifact the "everything" claim didn't cover. Nothing was leaking that shouldn't (the data
is synthetic by construction, and I re-verified with a grep that no password or SSN-shaped
string appears in any *text* artifact under `/evidence/`), so this was a documentation
bug rather than a security one — but in the section of the write-up an evaluator will read
most adversarially, an unqualified "everything" next to a visible SSN is the kind of thing
that should cost you the benefit of the doubt. Fixed by scoping the docstring to text
artifacts and naming screenshots as the explicit exception, and by adding the limit to
`REPORT.md` §6 with what closing it would actually take (OCR-and-blur over declared
sensitive regions, or not persisting screenshots of screens carrying declared-sensitive
fields at all). Worth recording because of where it came from: not a test, not a review of
the redaction code, but the ordinary act of looking carefully at an artifact I was about
to put in front of someone else.

## 6. Decisions made explicitly, and what I rejected

- **Semantic locators over CSS/XPath, and over a screenshot+coordinates default.**
  Rejected outright given the target app's randomized ids — considered and rejected
  screenshot+coordinates as the *primary* strategy (only kept it as the documented
  last-resort in the desktop-surface write-up, `src/surface/desktop/README.md`) because it
  fails silently on any layout shift and can't express "the field labelled X" the way a
  human would describe a legacy screen.
- **Three separate rule lists (`outcomes`/`recovery`/`faults`) over one rule list with a
  severity enum.** A severity field is one bad classification away from conflating "no
  such member" with "the app crashed" — the brief calls this out as the most common
  mistake, so I made it a type-level distinction instead of a value one.
- **Compiler as a separate, model-free pass rather than folding hardening into the
  discovery loop.** Considered asking the model to self-review its own recording (a
  second LLM pass), rejected it: I wanted the checkpoint audit (§5.3) to be
  deterministic and re-runnable without spending another call, and "does this literal
  text appear on this literal screen" is exactly the kind of check a model is worse at
  and slower for than a regex against a stored snapshot.
- **`irreversible` steps default to `confirm`, not `block`.** Blocking outright would
  make the system unable to do the servicing work it exists to do (the brief's own
  example is opening a sub-account); allowing it unattended risks a double-post. `confirm`
  — resolved either by an explicit `--confirm` or by a live human through escalation — was
  the only option that didn't make one of the two required capabilities (§3.2's "a
  non-trivial multi-step flow") impossible to actually run.
- **`--operator-sim` as a scripted stand-in using the *same* input path a human uses,**
  rather than a separate "fake escalation" code path. I wanted the automated evidence run
  to prove the real control-lease/input mechanism works, not a shortcut that looks similar
  but skips the part that matters.

For the cuts I made no attempt to fix — infrastructure that would be premature to build
now, not bugs — see `REPORT.md` §7.
