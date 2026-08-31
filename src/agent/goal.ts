/**
 * A discovery job spec. Kept as a file rather than a pile of CLI flags because
 * the typed parameter contract is a design decision worth reviewing in a diff:
 * it declares what the resulting capability will accept, including which inputs
 * are regulated data, before a single screen is touched.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { zRisk, zSensitivity, zValueType } from '../core/artifact.js';

export const zGoalSpec = z.object({
  /** Callable capability name. Verb-first snake_case. */
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  title: z.string(),
  goal: z.string(),
  productId: z.string(),
  variant: z.string().default('base'),
  surface: z.enum(['web', 'desktop']).default('web'),
  entry: z.string(),
  profile: z.string(),
  params: z.array(z.object({
    name: z.string().regex(/^[a-z][A-Za-z0-9_]*$/),
    type: zValueType,
    description: z.string(),
    sensitivity: zSensitivity.default('internal'),
    pattern: z.string().optional(),
    required: z.boolean().default(true),
    example: z.string().optional(),
    /** Concrete value used for the discovery run only; never persisted. */
    value: z.string(),
  })).default([]),
  maxSteps: z.number().int().positive().default(14),
  policy: z.object({
    maxDurationMs: z.number().int().positive().default(120_000),
    allowUnattended: z.boolean().default(false),
    requiresConfirmation: z.array(zRisk).default(['irreversible']),
  }).default({ maxDurationMs: 120_000, allowUnattended: false, requiresConfirmation: ['irreversible'] }),
});
export type GoalSpec = z.infer<typeof zGoalSpec>;

export const loadGoalSpec = (path: string): GoalSpec => zGoalSpec.parse(JSON.parse(readFileSync(path, 'utf8')));
