/**
 * Redaction. Regulated financial data must never reach an artifact, a journal,
 * a screenshot path, or an intervention payload.
 *
 * Two complementary mechanisms, because either alone leaks:
 *  - *pattern* scrubbing catches data we never knew about (an SSN rendered on a
 *    member-detail screen we happened to observe);
 *  - *value* scrubbing catches data we do know about (the password we just
 *    typed, the member id the caller passed as a `pii` input), including where
 *    it appears in a form we would not otherwise recognize.
 *
 * Everything written to disk goes through one Redactor instance, so there is a
 * single place to audit.
 */
import { createHash } from 'node:crypto';

export interface RedactionRule { label: string; pattern: RegExp }

const BUILTIN: RedactionRule[] = [
  { label: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: 'ssn', pattern: /\bSSN\s*[:#]?\s*\d{3}[- ]?\d{2}[- ]?\d{4}\b/gi },
  { label: 'pan', pattern: /\b(?:\d{4}[ -]?){3}\d{1,7}\b/g },
  { label: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { label: 'phone', pattern: /\b\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g },
  { label: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?\b/g },
  { label: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._-]{12,}/gi },
  { label: 'credential', pattern: /\b(password|passwd|pwd|pin|secret|token|api[_-]?key)\b\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi },
];

/** Object keys whose values are dropped wholesale, whatever they look like. */
const SENSITIVE_KEYS = /^(password|passwd|pwd|pin|secret|token|apikey|api_key|authorization|cookie|ssn|taxid)$/i;

export const hashRef = (v: string): string => 'sha256:' + createHash('sha256').update(v).digest('hex').slice(0, 12);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Redactor {
  private rules: RedactionRule[];
  /** Exact literals to scrub anywhere they appear, with their label. */
  private literals: Array<{ label: string; re: RegExp }> = [];

  constructor(extraPatterns: string[] = []) {
    this.rules = [...BUILTIN];
    for (const p of extraPatterns) {
      try { this.rules.push({ label: 'custom', pattern: new RegExp(p, 'gi') }); } catch { /* ignore bad config regex */ }
    }
  }

  /**
   * Register a value that must never be logged. Secrets are always registered;
   * `pii`-classified input values are registered too, so a member id supplied
   * by the caller does not end up in a journal line.
   */
  registerValue(value: string | undefined, label: string): void {
    if (!value || value.length < 4) return; // too short to scrub safely
    if (this.literals.some((l) => l.label === label && l.re.source === escapeRe(value))) return;
    this.literals.push({ label, re: new RegExp(escapeRe(value), 'g') });
  }

  text(s: string): string {
    let out = s;
    for (const { label, re } of this.literals) out = out.replace(re, `«${label}»`);
    for (const { label, pattern } of this.rules) {
      out = out.replace(pattern, (m) => (label === 'credential' ? m.split(/[:=]/)[0] + '=«credential»' : `«${label}»`));
    }
    return out;
  }

  /** Deep-redact an arbitrary JSON value: keys, strings, everything. */
  json<T>(v: T): T {
    return this.walk(v) as T;
  }

  private walk(v: unknown): unknown {
    if (typeof v === 'string') return this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = SENSITIVE_KEYS.test(k)
          ? (typeof val === 'string' && val ? `«${k.toLowerCase()}:${hashRef(val)}»` : '«redacted»')
          : this.walk(val);
      }
      return out;
    }
    return v;
  }

  /** Did anything actually match? Used by the artifact compiler as a tripwire. */
  wouldRedact(s: string): boolean {
    return this.text(s) !== s;
  }
}
