/**
 * The agent-facing surface: saved artifacts as a catalog of callable
 * capabilities with typed arguments.
 *
 * This is what closes the loop the brief describes — the agent-facing product
 * decides *what* to do and calls a capability by name; this system does it. The
 * catalog is generated from the artifacts themselves, so a capability's contract
 * and its tool definition cannot drift apart.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Capability, CapabilityInput, Risk } from '../core/artifact.js';
import { loadCapability } from '../core/load.js';

export interface CatalogEntry {
  path: string;
  capability: Capability;
}

export function loadCatalog(dir: string): CatalogEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: CatalogEntry[] = [];
  for (const f of files) {
    const path = join(dir, f);
    try {
      out.push({ path, capability: loadCapability(path) });
    } catch (e) {
      // A malformed artifact must not take the whole catalog down, but it must
      // be visible: an agent calling it would fail anyway.
      out.push({ path, capability: undefined as unknown as Capability });
      process.stderr.write(`[catalog] skipping ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
      out.pop();
    }
  }
  return out.sort((a, b) => a.capability.name.localeCompare(b.capability.name));
}

const JSON_TYPE: Record<CapabilityInput['type'], string> = {
  string: 'string', integer: 'string', number: 'string', money: 'string', date: 'string', boolean: 'boolean',
};

/**
 * Numeric inputs are exposed as strings on purpose: they are typed verbatim into
 * a UI field, and "00123" is not 123 on a fixed-width legacy screen.
 */
export function toToolDefinition(cap: Capability) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const i of cap.contract.inputs) {
    properties[i.name] = {
      type: JSON_TYPE[i.type],
      description: `${i.description}${i.pattern ? ` (must match ${i.pattern})` : ''}${i.sensitivity === 'pii' ? ' [regulated data]' : ''}`,
      ...(i.example ? { examples: [i.example] } : {}),
    };
    if (i.required) required.push(i.name);
  }
  const risks = [...new Set(cap.steps.map((s) => s.risk))] as Risk[];
  const needsConfirm = risks.some((r) => cap.policy.requiresConfirmation.includes(r));
  if (needsConfirm) {
    properties.confirm = {
      type: 'boolean',
      description: `Required. This capability performs ${risks.filter((r) => cap.policy.requiresConfirmation.includes(r)).join('/')} actions; pass true only with authority to do so.`,
    };
    required.push('confirm');
  }

  const returns = cap.contract.outputs.map((o) => `${o.name}: ${o.type} — ${o.description}`).join('; ') || 'nothing';

  return {
    name: cap.name,
    description: [
      cap.title,
      cap.description,
      `Returns → ${returns}.`,
      `May instead return a business outcome the caller must handle (for example: no such record, not authorized).`,
      `Approval state: ${cap.approval.state}. Unattended use: ${cap.policy.allowUnattended ? 'permitted' : 'not permitted'}.`,
    ].join(' '),
    input_schema: { type: 'object', properties, required, additionalProperties: false },
  };
}

export interface CatalogSummary {
  name: string;
  id: string;
  version: number;
  title: string;
  product: string;
  variant: string;
  approval: string;
  unattended: boolean;
  risks: Risk[];
  inputs: string[];
  outputs: string[];
  stability: { replays: number; successes: number; successRate?: number };
  path: string;
}

export const summarize = (e: CatalogEntry): CatalogSummary => ({
  name: e.capability.name,
  id: e.capability.id,
  version: e.capability.version,
  title: e.capability.title,
  product: e.capability.app.productId,
  variant: e.capability.app.variant,
  approval: e.capability.approval.state,
  unattended: e.capability.policy.allowUnattended,
  risks: [...new Set(e.capability.steps.map((s) => s.risk))],
  inputs: e.capability.contract.inputs.map((i) => `${i.name}:${i.type}${i.required ? '' : '?'}`),
  outputs: e.capability.contract.outputs.map((o) => `${o.name}:${o.type}`),
  stability: e.capability.stability,
  path: e.path.split('\\').join('/'),
});

export function findByName(dir: string, name: string): CatalogEntry {
  const hit = loadCatalog(dir).find((e) => e.capability.name === name || e.capability.id === name);
  if (!hit) throw new Error(`no capability named "${name}" in ${dir}`);
  return hit;
}
