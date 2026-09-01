/**
 * Evidence. Every run — discovery or replay — writes one directory containing a
 * JSONL journal of what happened and why, plus richer artefacts (screenshots,
 * observations, frame source) captured at decision points and on failure.
 *
 * Every *text* artefact written here — the journal itself, observation
 * snapshots, frame-source dumps — passes through the Redactor first, with no
 * second path to disk. Screenshots are the one exception: they are raw
 * viewport pixels, and the Redactor operates on strings, not images, so a
 * value rendered on screen (a member's SSN on a detail screen, say) is not
 * masked the way the same value would be in the journal line describing that
 * screen. That's a real limit, not an oversight — see REPORT.md §6 — and it's
 * why screenshots should be treated as the least-trusted evidence artifact for
 * storage/retention purposes even though everything else in this directory is
 * provably scrubbed.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Observation } from '../core/target.js';
import type { Surface } from '../surface/surface.js';
import type { Redactor } from '../policy/redact.js';

export type EventKind =
  | 'run.start' | 'run.end'
  | 'observe'
  | 'policy.check' | 'policy.deny'
  | 'action' | 'action.error'
  | 'resolve' | 'resolve.fail'
  | 'checkpoint' | 'checkpoint.fail'
  | 'monitor.outcome' | 'monitor.recovery' | 'monitor.fault'
  | 'recovery.start' | 'recovery.end'
  | 'extract'
  | 'llm.request' | 'llm.response' | 'llm.error'
  | 'escalation.raised' | 'escalation.resolved'
  | 'lease.transfer'
  | 'human.action'
  | 'drift'
  | 'artifact.emit'
  | 'note';

export interface JournalMeta {
  runId: string;
  mode: 'discovery' | 'replay';
  capability?: string;
  tenant?: string | null;
  goal?: string;
}

export class Journal {
  readonly dir: string;
  readonly journalPath: string;
  private seq = 0;
  private shots: string[] = [];

  constructor(baseDir: string, readonly meta: JournalMeta, private redactor: Redactor) {
    this.dir = join(baseDir, `${meta.mode}-${meta.runId}`);
    mkdirSync(join(this.dir, 'screens'), { recursive: true });
    mkdirSync(join(this.dir, 'observations'), { recursive: true });
    this.journalPath = join(this.dir, 'journal.jsonl');
    this.event('run.start', { ...meta, startedAt: new Date().toISOString() });
  }

  get screenshots(): string[] { return this.shots; }

  event(kind: EventKind, data: Record<string, unknown> = {}): void {
    // `data` legitimately carries its own `kind` field in several call sites
    // (an action's kind, e.g. 'click'/'dialog', logged inside a 'policy.check'
    // or 'action' event) — spread order matters: the event-type discriminator
    // must win, or the journal's own `kind` column silently corrupts.
    const line = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      runId: this.meta.runId,
      ...this.redactor.json(data),
      kind,
    };
    appendFileSync(this.journalPath, JSON.stringify(line) + '\n', 'utf8');
  }

  /** Compact, redacted view of an observation — what the automation could see. */
  async saveObservation(obs: Observation, label: string): Promise<string> {
    const name = `${String(this.seq).padStart(3, '0')}-${slug(label)}.json`;
    const path = join(this.dir, 'observations', name);
    const compact = {
      id: obs.id,
      locus: obs.locus,
      title: obs.title,
      fingerprint: obs.fingerprint,
      frames: obs.frames,
      pendingDialog: obs.pendingDialog,
      controls: obs.controls.map((c) => ({
        ref: c.ref, role: c.role, name: c.name, labels: c.labels, value: c.value,
        container: c.container, frame: c.frame, ordinal: c.ordinal, enabled: c.enabled, bbox: c.bbox,
      })),
      text: obs.text,
    };
    writeFileSync(path, JSON.stringify(this.redactor.json(compact), null, 2), 'utf8');
    return this.rel(path);
  }

  async saveScreenshot(surface: Surface, label: string): Promise<string | undefined> {
    let buf: Buffer;
    try { buf = await surface.screenshot(); } catch { return undefined; }
    if (buf.length === 0) return undefined; // renderer blocked by a modal
    const name = `${String(this.seq).padStart(3, '0')}-${slug(label)}.png`;
    const path = join(this.dir, 'screens', name);
    writeFileSync(path, buf);
    const rel = this.rel(path);
    this.shots.push(rel);
    return rel;
  }

  /** On failure only: full frame source, so a locator regression is diagnosable. */
  async saveSourceSnapshot(surface: Surface, label: string): Promise<string | undefined> {
    let src: string;
    try { src = await surface.sourceSnapshot(); } catch { return undefined; }
    const path = join(this.dir, `snapshot-${slug(label)}.html`);
    writeFileSync(path, this.redactor.text(src), 'utf8');
    return this.rel(path);
  }

  writeJson(name: string, value: unknown, opts: { redact?: boolean } = {}): string {
    const path = join(this.dir, name);
    const body = opts.redact === false ? value : this.redactor.json(value);
    writeFileSync(path, JSON.stringify(body, null, 2), 'utf8');
    return this.rel(path);
  }

  appendJsonl(name: string, value: unknown): string {
    const path = join(this.dir, name);
    appendFileSync(path, JSON.stringify(this.redactor.json(value)) + '\n', 'utf8');
    return this.rel(path);
  }

  private rel(p: string): string {
    return relative(process.cwd(), p).split('\\').join('/');
  }

  relPath(p: string): string { return this.rel(p); }

  end(summary: Record<string, unknown>): void {
    this.event('run.end', summary);
  }
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
