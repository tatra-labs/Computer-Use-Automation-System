/**
 * The web driver. One of possibly several Surface implementations; nothing above
 * it imports Playwright.
 *
 * Notable choices:
 *  - Native dialogs are captured, never auto-dismissed. A pending dialog becomes
 *    observable state that the flow must answer explicitly, because on a banking
 *    surface "are you sure you want to post this" is a decision, not noise.
 *  - Screenshots are viewport-sized so operator-console coordinates map 1:1 onto
 *    real CSS pixels of the same live page.
 *  - Element handles are resolved lazily, per action, from the array the
 *    extractor left in the page. No DOM mutation, no injected attributes.
 */
import { createHash } from 'node:crypto';
import { Browser, BrowserContext, Dialog, Frame, Page, chromium } from 'playwright';
import type { Surface, TypeOptions } from '../surface.js';
import { SurfaceError } from '../surface.js';
import { Control, Observation, Role } from '../../core/target.js';
import { extractFrame, RawFrame } from './extract.js';

const ROLE_SET = new Set<string>([
  'button', 'link', 'textbox', 'password', 'combobox', 'option', 'checkbox', 'radio',
  'tab', 'menuitem', 'cell', 'columnheader', 'row', 'heading', 'text', 'alert', 'dialog', 'image',
]);
const asRole = (r: string): Role => (ROLE_SET.has(r) ? (r as Role) : 'unknown');

/**
 * The extractor runs inside the page, so it cannot depend on anything from this
 * module's scope — including the transpiler's own helpers. esbuild's `keepNames`
 * wraps inner function declarations in `__name`, which does not exist in a
 * browser context. Supplying a no-op in every frame is less fragile than
 * string-splicing the extractor's source, and keeps it a type-checked function.
 */
const ESBUILD_HELPER_SHIM = 'globalThis.__name = globalThis.__name || function (f) { return f; };';

export interface WebSurfaceOptions {
  headless: boolean;
  viewport?: { width: number; height: number };
  /** Applied to every navigation and checkpoint poll. */
  defaultTimeoutMs?: number;
}

export class WebSurface implements Surface {
  readonly kind = 'web' as const;
  private browser!: Browser;
  private ctx!: BrowserContext;
  private page!: Page;
  private refMap = new Map<string, { frame: Frame; idx: number }>();
  private pendingDialog: Dialog | null = null;
  private dialogWaiters: Array<() => void> = [];
  private obsSeq = 0;
  private timeout: number;

  constructor(private opts: WebSurfaceOptions) {
    this.timeout = opts.defaultTimeoutMs ?? 10_000;
  }

  static async launch(opts: WebSurfaceOptions): Promise<WebSurface> {
    const s = new WebSurface(opts);
    await s.start();
    return s;
  }

  private async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.opts.headless });
    this.ctx = await this.browser.newContext({
      viewport: this.opts.viewport ?? { width: 1280, height: 800 },
      // Legacy back-office apps are desktop-only; don't let a mobile UA change the render.
      deviceScaleFactor: 1,
    });
    await this.ctx.addInitScript({ content: ESBUILD_HELPER_SHIM });
    this.page = await this.ctx.newPage();
    this.page.setDefaultTimeout(this.timeout);
    this.page.on('dialog', (d) => {
      this.pendingDialog = d;
      const ws = this.dialogWaiters;
      this.dialogWaiters = [];
      for (const w of ws) w();
    });
  }

  get playwrightPage(): Page { return this.page; }

  currentLocus(): string {
    return this.page.url();
  }

  // -- dialog plumbing -------------------------------------------------------

  /**
   * A click that opens a native modal blocks the renderer, so the click promise
   * may never settle. Racing it against the dialog event keeps the driver
   * responsive and turns the modal into observable state.
   */
  private async raceDialog<T>(p: Promise<T>): Promise<void> {
    const appeared = new Promise<void>((res) => {
      if (this.pendingDialog) return res();
      this.dialogWaiters.push(res);
    });
    await Promise.race([p.then(() => undefined).catch((e) => { if (!this.pendingDialog) throw e; }), appeared]);
  }

  async answerDialog(decision: 'accept' | 'dismiss'): Promise<void> {
    const d = this.pendingDialog;
    if (!d) throw new SurfaceError('answerDialog called with no dialog pending');
    this.pendingDialog = null;
    if (decision === 'accept') await d.accept();
    else await d.dismiss();
    await this.settle();
  }

  // -- perception ------------------------------------------------------------

  private frameChain(f: Frame): string[] {
    const chain: string[] = [];
    let cur: Frame | null = f;
    while (cur) {
      const n = cur.name();
      if (n) chain.unshift(n);
      cur = cur.parentFrame();
    }
    return chain;
  }

  async settle(maxMs = 4000): Promise<void> {
    if (this.pendingDialog) return;
    try {
      // 'load' rather than 'domcontentloaded': a frameset's document is complete
      // long before its frames have documents to inspect, and legacy apps are
      // built out of framesets.
      await this.page.waitForLoadState('load', { timeout: maxMs });
      // One frame of quiet is enough for server-rendered pages; we poll
      // checkpoints rather than sleeping, so this is only jitter smoothing.
      await this.page.waitForTimeout(60);
    } catch { /* a slow load surfaces as a checkpoint failure, with evidence */ }
  }

  async observe(): Promise<Observation> {
    const id = `obs${++this.obsSeq}`;
    const capturedAt = new Date().toISOString();

    // A blocked renderer cannot be inspected. Report the modal as the state.
    if (this.pendingDialog) {
      const d = this.pendingDialog;
      return {
        id, surface: 'web', locus: this.page.url(), title: '(dialog)',
        frames: [], controls: [], text: d.message(),
        pendingDialog: { kind: d.type(), message: d.message() },
        fingerprint: 'dialog:' + createHash('sha256').update(d.message()).digest('hex').slice(0, 12),
        viewport: this.viewport(), capturedAt,
      };
    }

    this.refMap.clear();
    let sweep = await this.sweepFrames();
    // A frame swapped out mid-sweep (very common right after a form post in a
    // frameset app) yields a partial or empty perception. Retry once rather than
    // reporting an empty screen, which would look like a missing control.
    if (sweep.frames.length === 0 || sweep.controls.length === 0) {
      await this.settle(1500);
      sweep = await this.sweepFrames();
    }
    // Perceiving nothing at all is a driver failure, not an empty screen. Left
    // silent it would surface much later as a baffling TARGET_NOT_FOUND.
    if (sweep.frames.length === 0) {
      throw new SurfaceError(`could not perceive any frame at ${this.page.url()}: ${this.lastSweepError ?? 'unknown cause'}`);
    }
    const { controls, texts, frames } = sweep;
    for (const [ref, entry] of sweep.refs) this.refMap.set(ref, entry);

    assignOrdinals(controls);
    const text = texts.join('\n').replace(/[ \t]+/g, ' ');

    return {
      id, surface: 'web',
      locus: this.page.url(),
      title: await this.page.title().catch(() => ''),
      frames, controls, text,
      fingerprint: fingerprintOf(controls),
      viewport: this.viewport(),
      capturedAt,
    };
  }

  /** Last error from an in-page evaluation, surfaced for debugging. */
  lastSweepError: string | undefined;

  private async sweepFrames(): Promise<{
    controls: Control[];
    texts: string[];
    frames: Array<{ name: string; url: string }>;
    refs: Array<[string, { frame: Frame; idx: number }]>;
  }> {
    const controls: Control[] = [];
    const texts: string[] = [];
    const frames: Array<{ name: string; url: string }> = [];
    const refs: Array<[string, { frame: Frame; idx: number }]> = [];

    for (const f of this.page.frames()) {
      let raw: RawFrame;
      try {
        raw = await f.evaluate(extractFrame, 400);
      } catch (e) {
        this.lastSweepError = e instanceof Error ? e.message : String(e);
        continue; // detached or navigating mid-observation
      }
      const chain = this.frameChain(f);
      frames.push({ name: chain.join('/') || '(root)', url: raw.url });
      if (raw.text) texts.push(raw.text);
      const fkey = frames.length - 1;
      for (const rc of raw.controls) {
        const ref = `f${fkey}c${rc.idx}`;
        refs.push([ref, { frame: f, idx: rc.idx }]);
        controls.push({
          ref,
          role: asRole(rc.role),
          name: rc.name,
          labels: rc.labels,
          value: rc.value,
          description: rc.description,
          container: rc.container,
          frame: chain,
          ordinal: 0,
          enabled: rc.enabled,
          bbox: rc.bbox,
          hint: { tag: rc.tag, attrName: rc.attrName, type: rc.type },
        });
      }
    }
    return { controls, texts, frames, refs };
  }

  private viewport() {
    const v = this.page.viewportSize();
    return { w: v?.width ?? 0, h: v?.height ?? 0 };
  }

  // -- action ----------------------------------------------------------------

  private async handle(ref: string) {
    const entry = this.refMap.get(ref);
    if (!entry) throw new SurfaceError(`unknown control ref "${ref}" (observe() again)`);
    const jsh = await entry.frame.evaluateHandle(
      (i: number) => (window as unknown as { __hs?: { nodes: Element[] } }).__hs?.nodes[i],
      entry.idx,
    );
    const el = jsh.asElement();
    if (!el) throw new SurfaceError(`control ref "${ref}" is stale (page changed since observe())`);
    return el;
  }

  async navigate(locus: string): Promise<void> {
    try {
      await this.page.goto(locus, { waitUntil: 'load', timeout: this.timeout });
      await this.settle();
    } catch (e) {
      throw new SurfaceError(`navigate to ${locus} failed`, e);
    }
  }

  async click(ref: string): Promise<void> {
    const el = await this.handle(ref);
    await el.scrollIntoViewIfNeeded().catch(() => undefined);
    await this.raceDialog(el.click({ timeout: this.timeout }));
    await this.settle();
  }

  async type(ref: string, text: string, opts: TypeOptions): Promise<void> {
    const el = await this.handle(ref);
    await el.scrollIntoViewIfNeeded().catch(() => undefined);
    if (opts.clearFirst) await el.fill('');
    // Real key events: legacy screens often key off keydown handlers.
    await el.type(text, { delay: 8 });
    if (opts.pressEnter) {
      await this.raceDialog(el.press('Enter'));
      await this.settle();
    }
  }

  async select(ref: string, value: string): Promise<void> {
    const el = await this.handle(ref);
    try {
      await el.selectOption({ value });
    } catch {
      await el.selectOption({ label: value });
    }
    await this.settle();
  }

  async press(key: string): Promise<void> {
    await this.raceDialog(this.page.keyboard.press(key));
    await this.settle();
  }

  async screenshot(): Promise<Buffer> {
    if (this.pendingDialog) {
      // The renderer is blocked; a screenshot would hang. Report the modal.
      return Buffer.from('');
    }
    return this.page.screenshot({ type: 'png' });
  }

  async sourceSnapshot(): Promise<string> {
    // frame.content() evaluates JS in the page. A native dialog (confirm/alert/
    // prompt) freezes that frame's JS execution until it is answered, and
    // content() carries no timeout of its own — calling it here would hang the
    // run indefinitely at exactly the moment (an unresolved dialog) evidence is
    // most needed. Match screenshot()'s and observe()'s guard.
    if (this.pendingDialog) {
      return `<!-- source snapshot unavailable: a ${this.pendingDialog.type()} dialog is blocking the page: "${this.pendingDialog.message()}" -->`;
    }
    const parts: string[] = [];
    for (const f of this.page.frames()) {
      const chain = this.frameChain(f).join('/') || '(root)';
      let html = '';
      try { html = await f.content(); } catch { html = '<!-- frame detached -->'; }
      parts.push(`<!-- ===== frame ${chain} @ ${f.url()} ===== -->\n${html}`);
    }
    return parts.join('\n\n');
  }

  operator = {
    click: async (x: number, y: number): Promise<void> => {
      await this.raceDialog(this.page.mouse.click(x, y));
      await this.settle();
    },
    typeText: async (text: string): Promise<void> => {
      await this.page.keyboard.type(text, { delay: 12 });
    },
    key: async (key: string): Promise<void> => {
      await this.raceDialog(this.page.keyboard.press(key));
      await this.settle();
    },
    scroll: async (dx: number, dy: number): Promise<void> => {
      await this.page.mouse.wheel(dx, dy);
    },
  };

  async close(): Promise<void> {
    if (this.pendingDialog) { await this.pendingDialog.dismiss().catch(() => undefined); this.pendingDialog = null; }
    await this.ctx?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
  }
}

/**
 * Ordinals disambiguate genuinely identical controls (repeated grid rows) and
 * must be assigned the same way every run: document order within a
 * frame+container+role+label bucket.
 */
export function assignOrdinals(controls: Control[]): void {
  const seen = new Map<string, number>();
  for (const c of controls) {
    const key = [c.frame.join('/'), c.container[0] ?? '', c.role, c.name || c.labels[0] || ''].join('|');
    const n = seen.get(key) ?? 0;
    c.ordinal = n;
    seen.set(key, n + 1);
  }
}

/**
 * Structural fingerprint: the shape of the screen (roles + captions), ignoring
 * values. Two runs of the same screen with different data hash the same; a
 * vendor upgrade that adds a field does not. Used as a drift signal, never as a
 * gate — a changed fingerprint is logged, and the run proceeds on its locators.
 */
export function fingerprintOf(controls: Control[]): string {
  const shape = controls
    .map((c) => `${c.role}:${(c.name || c.labels[0] || '').toUpperCase().slice(0, 32)}`)
    .sort()
    .join(';');
  return 'shape:' + createHash('sha256').update(shape).digest('hex').slice(0, 16);
}
