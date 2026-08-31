/**
 * Output extraction. Declared outputs are read with the same target vocabulary
 * as actions, so "the balance cell in the row labelled REG SAVINGS under the
 * CURRENT BALANCE column" is expressed once and survives the same kinds of
 * change a click target does.
 */
import type { CapabilityOutput } from '../core/artifact.js';
import { interpolate, interpolateTarget, ParamValues } from '../core/predicate.js';
import { resolveTarget } from '../core/resolve.js';
import type { Observation } from '../core/target.js';

export type ExtractResult =
  | { ok: true; value: string | number | boolean; raw: string }
  | { ok: false; reason: string };

function applyTransforms(v: string, transforms: CapabilityOutput['transform']): string {
  let out = v;
  for (const t of transforms) {
    switch (t) {
      case 'trim': out = out.trim(); break;
      case 'upper': out = out.toUpperCase(); break;
      case 'digits': out = out.replace(/\D+/g, ''); break;
      case 'collapseSpace': out = out.replace(/\s+/g, ' ').trim(); break;
      // Legacy screens render money as "4,812.63" or "$4,812.63 CR".
      case 'money': out = out.replace(/[^0-9.\-]/g, ''); break;
    }
  }
  return out;
}

function coerce(v: string, type: CapabilityOutput['type']): ExtractResult {
  switch (type) {
    case 'integer': {
      if (!/^-?\d+$/.test(v)) return { ok: false, reason: `"${v}" is not an integer` };
      return { ok: true, value: Number(v), raw: v };
    }
    case 'number':
    case 'money': {
      if (!/^-?\d+(\.\d+)?$/.test(v)) return { ok: false, reason: `"${v}" is not numeric` };
      return { ok: true, value: Number(v), raw: v };
    }
    case 'boolean':
      return { ok: true, value: /^(1|true|yes|y|active)$/i.test(v), raw: v };
    default:
      return { ok: true, value: v, raw: v };
  }
}

export function extractOutput(obs: Observation, out: CapabilityOutput, params: ParamValues): ExtractResult {
  let raw: string | undefined;

  switch (out.source.kind) {
    case 'pageRegex': {
      const pattern = interpolate(out.source.pattern, params);
      let re: RegExp;
      try { re = new RegExp(pattern, 'i'); } catch { return { ok: false, reason: `invalid regex ${pattern}` }; }
      const m = re.exec(obs.text);
      if (!m) return { ok: false, reason: `page text does not match /${pattern}/i` };
      raw = m[out.source.group] ?? m[0];
      break;
    }
    case 'controlText':
    case 'controlValue': {
      const r = resolveTarget(obs, interpolateTarget(out.source.target, params));
      if (r.status !== 'resolved') {
        return { ok: false, reason: `output "${out.name}": target ${r.status}` };
      }
      raw = out.source.kind === 'controlValue' ? (r.control.value ?? '') : (r.control.name || r.control.labels[0] || '');
      break;
    }
  }

  if (raw === undefined || raw === '') return { ok: false, reason: `output "${out.name}" resolved to empty text` };
  return coerce(applyTransforms(raw, out.transform), out.type);
}
