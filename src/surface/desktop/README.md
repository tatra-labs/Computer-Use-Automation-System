# Desktop surface (Windows UI Automation)

`uia-surface.ts` is a typed, deliberately unimplemented `Surface`. It exists so the
"this generalizes beyond a browser" claim is checkable by the compiler rather than
asserted in prose: it satisfies `src/surface/surface.ts` today, and its two pure
mapping functions — `mapUiaControlType`, `controlFromUiaElement` — are real and
tested in `test/desktop-surface.test.ts`.

## (a) What a real implementation would use

Three viable bindings, in the order I would try them:

1. **A small C# sidecar** over `System.Windows.Automation` / the newer
   `Interop.UIAutomationClient`, speaking newline-delimited JSON-RPC on stdio:
   `observe → {elements: UiaElement[], windowRect, title}`, plus
   `invoke/setValue/select/setFocus/sendKeys/capture(hwnd)`. UIA is COM and
   apartment-threaded; keeping it in-process via node-ffi means marshalling
   `IUIAutomationElement` pointers across the FFI boundary and pumping an STA
   message loop inside Node's event loop. A sidecar makes that someone else's
   problem, keeps element pointers on the side that owns them, and gives a crash
   boundary — a hung legacy provider kills the sidecar, not the run. Rust +
   `windows-rs` is the same design with a different toolchain.
2. **node-ffi directly** — no extra process, but the COM/STA plumbing above lands
   inside the agent, and one blocking `FindAll` on a 40k-node Delphi grid stalls
   everything.
3. **WinAppDriver** — free WebDriver semantics, and the fastest thing to stand up.
   Its locator model (`AutomationId`, `Name`, XPath over the AX tree) is exactly
   the id-shaped brittleness `Control.hint` quarantines, so I would use it to
   bootstrap and still compute names/captions/containment from the tree it
   returns rather than from its XPath.

The wire shape stays `UiaElement` as declared here: flat properties, `ancestors`
as the TreeWalker parent chain, no live handles. Refs are minted per `observe()`
and mapped back to element pointers sidecar-side — the same contract as the web
surface's `__hs.nodes` index.

## (b) What changes, and what does not

Unchanged, and this is the whole point:

- `src/core/target.ts` — `Role`, `Control`, `Observation`, `TargetDescriptor`.
  UIA supplies every field natively: ControlType → role, Name → accessible name,
  TreeWalker → containment and caption adjacency, BoundingRectangle → bbox.
- `src/core/resolve.ts` — scoring, ambiguity margin, ordinal tie-breaks. Zero
  desktop knowledge; the desktop tests in `test/desktop-surface.test.ts` resolve
  synthetic UIA controls through the shipped resolver.
- `src/core/artifact.ts` — already carries `surface: 'web' | 'desktop'` on both
  `zAppProfile` and `zCapability.app`. No schema version bump, so existing
  artifacts stay valid.
- `src/core/predicate.ts`, `src/replay/engine.ts`, `src/replay/extract.ts`,
  `src/replay/monitors.ts`, `src/session/session.ts`, `src/session/lease.ts`,
  `src/policy/policy.ts`, `src/agent/prompt.ts` — all speak Observations and
  refs. The engine never imports a driver.

Changes, honestly:

- **`assignOrdinals` and `fingerprintOf` live in `src/surface/web/web-surface.ts`.**
  Both are surface-agnostic (they operate on `Control[]`). Implementing this
  surface means moving them into `src/core/` so the desktop driver does not import
  Playwright transitively. That is the one refactor the second surface forces.
- **`src/obs/journal.ts` hardcodes `snapshot-*.html`** for `sourceSnapshot()`.
  A UIA tree dump is not HTML; the extension needs to come from the surface.
- **Policy `allowlist.loci` regexes** are written against URLs in `policy/*.json`.
  The mechanism is unchanged — a locus is just a string — but a desktop policy
  matches `process:1234/Riverbend Back Office`, so every deployed policy file
  needs a desktop counterpart. Cheap, but not free, and it is a security control:
  a too-loose pattern is how the agent ends up driving the wrong window.
- **`src/escalation/operator-console.ts`** works as-is only if `observe()`
  normalizes bboxes from UIA screen coordinates into window-relative coordinates
  matching the `PrintWindow` capture. The 1:1 coordinate promise in
  `Surface.operator` is a real constraint, not a comment.
- **App profiles** (`app-profiles/*.json`) are per-product content, not code, and
  must be re-authored: session expiry on a thick client is a modal, not a
  redirect.

## (c) What genuinely does not carry over

- **`navigate()` has no URL.** There is no address bar and no deep link. A desktop
  locus is a window/process identity, and "navigate" degrades to *activate this
  window* or *launch the app and wait for its main window*. Reaching a screen is a
  menu walk, which means the capability's entry point becomes steps rather than a
  string — `zCapability.app.entry` stops being a one-shot recovery move, so the
  engine's "reopen the entry point" retry is weaker on desktop.
- **No DOM, so no source snapshot.** Failure evidence becomes screenshot plus a
  serialized AX tree. That is strictly worse for diagnosing a locator regression:
  the tree is what the resolver already saw, whereas HTML sometimes shows why a
  provider lied. Redaction also has to run over the tree dump field-wise
  (`Redactor.json`), not as flat text.
- **Window/process lifecycle replaces page lifecycle.** No `domcontentloaded`, no
  load state to await. Settling means polling until the tree stops changing (or
  the busy/ProgressBar element clears) with a timeout — a heuristic where the web
  surface has an event. Crashes and MDI child windows have no page analogue, and
  the app can also die while holding a lock the flow half-acquired.
- **Modals are OS windows, not page dialogs.** No `page.on('dialog')`. A pending
  dialog is detected by finding an owned, enabled, modal top-level window under
  the attached process, and `answerDialog()` invokes its default or cancel button.
  Two consequences: detection is a poll, not an event; and the renderer is *not*
  blocked, so unlike the web surface a screenshot during a modal is still valid.

## (d) When there is no accessibility tree at all

Citrix/RDP published apps, terminal emulators and custom-drawn grids expose one
opaque window (`Pane`/`Custom`, no children). Perception falls back to pixels:
OCR the capture into text boxes, template-match known glyphs/widgets, and act by
synthesized clicks at coordinates.

That breaks the property the whole design rests on. A `TargetDescriptor` currently
resolves *semantically* — the same descriptor holds when the field moves, the theme
changes, or the vendor reflows the screen. A coordinate resolves *visually*, so
determinism now depends on resolution, DPI, scroll offset, font smoothing, theme
and OCR confidence, and there is no honest `AMBIGUOUS_TARGET`: template matching
returns a best score, not a runner-up you can defend a margin against.

To support it I would extend `TargetDescriptor` with one optional variant rather
than loosen the existing fields:

```
anchor?: {
  template: string;        // hashRef to a stored crop, in the evidence store
  offset: { dx, dy };      // target relative to the matched anchor, not the window
  minConfidence: number;   // NCC score floor, analogous to minScore
  scaleTolerance: number;  // permitted DPI/resolution drift
}
```

Anchor-relative rather than absolute, because "18px right of the *MBR NO* caption"
survives a window move and a resize that "at (412, 233)" does not. `minConfidence`
mirrors `minScore` so a weak match fails closed instead of clicking approximately.

It stays a last resort, gated to `risk: 'read'` by default and requiring human
confirmation for anything that writes, because a mis-resolved coordinate on a
banking screen does not fail — it posts. The better fix is almost always upstream:
enable the app's own accessibility provider, run the app locally instead of over
Citrix, or use its terminal/API path. Pixel automation is the answer when there is
no other, and it should be visibly marked as such in the artifact.
