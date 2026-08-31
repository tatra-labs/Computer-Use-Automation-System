/**
 * The model boundary.
 *
 * The LLM is used for exactly one thing: deciding the next action during
 * *discovery*. It never runs during replay. Isolating it behind a one-method
 * interface makes that structural rather than a promise — grep for Planner and
 * you have found every place a model can influence behaviour.
 *
 * Two providers:
 *  - `AnthropicPlanner` is the production path: the Messages API with a strict
 *    single-tool contract, so the decision is schema-validated by the API rather
 *    than parsed out of prose.
 *  - `ClaudeCliPlanner` drives the locally-authenticated Claude Code CLI as a
 *    headless model endpoint. It exists because a raw `ANTHROPIC_API_KEY` is not
 *    always what a developer has to hand, and the committed evidence run had to
 *    be genuine. Same decision schema, same parser, same loop.
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';

export const zPlannedDecision = z.object({
  /** Why this action, in one sentence. Recorded as the step's intent. */
  thought: z.string(),
  tool: z.enum(['click', 'type', 'select', 'press', 'navigate', 'answer_dialog', 'done', 'stuck']),
  /** Control ref from the observation just shown. Required by click/type/select. */
  ref: z.string().optional(),
  text: z.string().optional(),
  value: z.string().optional(),
  key: z.string().optional(),
  locus: z.string().optional(),
  decision: z.enum(['accept', 'dismiss']).optional(),
  pressEnter: z.boolean().optional(),
  /** Classification of what this action does to the institution's data. */
  risk: z.enum(['read', 'write', 'irreversible']).optional(),
  /**
   * Text the model expects to see once the action has taken effect. Compiled
   * into the step's checkpoint predicate, which is how a recorded flow acquires
   * assertions instead of assuming its clicks worked.
   */
  expectAfter: z.string().optional(),
  /** On `done`: text that proves the goal was reached. */
  successText: z.string().optional(),
  /** On `done`: the values the capability should return to its caller. */
  outputs: z.array(z.object({
    name: z.string(),
    /** Control ref holding the value, from the final observation. */
    ref: z.string().optional(),
    /** Alternative: a regex over the page text with one capture group. */
    regex: z.string().optional(),
    type: z.enum(['string', 'integer', 'number', 'boolean', 'money', 'date']).default('string'),
    description: z.string().default(''),
    sensitivity: z.enum(['public', 'internal', 'pii', 'secret']).default('internal'),
  })).optional(),
  /** On `stuck`: what is blocking, for the human who will be paged. */
  reason: z.string().optional(),
});
export type PlannedDecision = z.infer<typeof zPlannedDecision>;

export interface PlannerInput {
  system: string;
  /** Fully rendered user turn: goal, parameters, history, current observation. */
  user: string;
}

export interface PlannerOutput {
  decision: PlannedDecision;
  raw: string;
  model: string;
  usage?: Record<string, unknown>;
}

export interface Planner {
  readonly id: string;
  readonly model: string;
  decide(input: PlannerInput): Promise<PlannerOutput>;
}

export class PlannerError extends Error {
  constructor(message: string, readonly raw?: string) { super(message); this.name = 'PlannerError'; }
}

/** Tolerant extraction: models occasionally wrap JSON in prose or a fence. */
export function parseDecision(raw: string): PlannedDecision {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidates = [fenced?.[1], raw].filter((s): s is string => !!s);
  for (const c of candidates) {
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      return zPlannedDecision.parse(JSON.parse(c.slice(start, end + 1)));
    } catch { /* try the next candidate */ }
  }
  throw new PlannerError('planner returned no parseable decision', raw.slice(0, 800));
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

const DECIDE_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    thought: { type: 'string', description: 'One sentence: why this action.' },
    tool: { type: 'string', enum: ['click', 'type', 'select', 'press', 'navigate', 'answer_dialog', 'done', 'stuck'] },
    ref: { type: 'string', description: 'Control ref from the observation, e.g. f1c7.' },
    text: { type: 'string' },
    value: { type: 'string' },
    key: { type: 'string' },
    locus: { type: 'string' },
    decision: { type: 'string', enum: ['accept', 'dismiss'] },
    pressEnter: { type: 'boolean' },
    risk: { type: 'string', enum: ['read', 'write', 'irreversible'] },
    expectAfter: { type: 'string', description: 'Text you expect on screen once this action has taken effect.' },
    successText: { type: 'string' },
    outputs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          ref: { type: 'string' },
          regex: { type: 'string' },
          type: { type: 'string', enum: ['string', 'integer', 'number', 'boolean', 'money', 'date'] },
          description: { type: 'string' },
          sensitivity: { type: 'string', enum: ['public', 'internal', 'pii', 'secret'] },
        },
        required: ['name', 'type', 'description', 'sensitivity'],
        additionalProperties: false,
      },
    },
    reason: { type: 'string' },
  },
  required: ['thought', 'tool'],
  additionalProperties: false,
};

export class AnthropicPlanner implements Planner {
  readonly id = 'anthropic-api';
  constructor(readonly model = 'claude-opus-5', private maxTokens = 4096) {}

  async decide(input: PlannerInput): Promise<PlannerOutput> {
    // Imported lazily so the CLI provider works with no SDK credentials present.
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();

    const res = await client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: input.system,
      tools: [{
        name: 'decide',
        description: 'Choose exactly one next action against the application surface.',
        input_schema: DECIDE_TOOL_SCHEMA,
        strict: true,
      }],
      tool_choice: { type: 'tool', name: 'decide' },
      messages: [{ role: 'user', content: input.user }],
    });

    const block = res.content.find((b) => b.type === 'tool_use' && b.name === 'decide');
    if (!block || block.type !== 'tool_use') {
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      throw new PlannerError('model did not call the decide tool', text);
    }
    return {
      decision: zPlannedDecision.parse(block.input),
      raw: JSON.stringify(block.input),
      model: this.model,
      usage: { ...res.usage } as unknown as Record<string, unknown>,
    };
  }
}

// ---------------------------------------------------------------------------
// Local Claude Code CLI as a headless model endpoint
// ---------------------------------------------------------------------------

export class ClaudeCliPlanner implements Planner {
  readonly id = 'claude-cli';
  constructor(
    readonly model = 'claude-opus-5',
    private opts: { timeoutMs?: number; effort?: string } = {},
  ) {}

  async decide(input: PlannerInput): Promise<PlannerOutput> {
    const args = [
      '-p', '--output-format', 'json',
      '--model', this.model,
      // Replace the CLI's own agent persona and remove its toolset: this must be
      // a bare model call, not a nested coding agent.
      '--system-prompt', input.system,
      '--tools', '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--setting-sources', '',
    ];
    if (this.opts.effort) args.push('--effort', this.opts.effort);

    const out = await run('claude', args, input.user, this.opts.timeoutMs ?? 240_000);
    let envelope: { result?: string; is_error?: boolean; usage?: Record<string, unknown>; total_cost_usd?: number };
    try {
      envelope = JSON.parse(out);
    } catch {
      throw new PlannerError('claude CLI did not return JSON', out.slice(0, 800));
    }
    if (envelope.is_error || typeof envelope.result !== 'string') {
      throw new PlannerError('claude CLI reported an error', out.slice(0, 800));
    }
    return {
      decision: parseDecision(envelope.result),
      raw: envelope.result,
      model: this.model,
      usage: { ...envelope.usage, total_cost_usd: envelope.total_cost_usd },
    };
  }
}

/**
 * Spawned WITHOUT a shell. On Windows a shell concatenates argv instead of
 * escaping it, which mangles a multi-line `--system-prompt` and silently turns
 * `--tools ""` into `--tools`. The candidate list covers the launcher shapes the
 * CLI ships as.
 */
function run(cmd: string, args: string[], stdin: string, timeoutMs: number): Promise<string> {
  const candidates = process.env.HANDSPAN_CLAUDE_BIN
    ? [process.env.HANDSPAN_CLAUDE_BIN]
    : process.platform === 'win32' ? [`${cmd}.exe`, `${cmd}.cmd`, cmd] : [cmd];

  const attempt = (i: number): Promise<string> => new Promise((resolve, reject) => {
    const bin = candidates[i]!;
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let spawnFailed = false;
    const timer = setTimeout(() => { child.kill(); reject(new PlannerError(`${bin} timed out after ${timeoutMs}ms`)); }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      spawnFailed = true;
      if (e.code === 'ENOENT' && i + 1 < candidates.length) return resolve(attempt(i + 1));
      reject(new PlannerError(`${bin} failed to start: ${e.message}`));
    });
    child.on('close', (code) => {
      if (spawnFailed) return;
      clearTimeout(timer);
      if (code !== 0) return reject(new PlannerError(`${bin} exited ${code}: ${stderr.slice(0, 500)}`));
      resolve(stdout);
    });
    child.stdin.on('error', () => undefined); // the child may exit before we finish writing
    child.stdin.write(stdin);
    child.stdin.end();
  });

  return attempt(0);
}

/**
 * Provider selection. An explicit `ANTHROPIC_API_KEY` wins; otherwise fall back
 * to the local CLI, which is authenticated interactively.
 */
export function selectPlanner(opts: { provider?: string; model?: string; effort?: string } = {}): Planner {
  const provider = opts.provider ?? (process.env.ANTHROPIC_API_KEY ? 'anthropic-api' : 'claude-cli');
  if (provider === 'anthropic-api') return new AnthropicPlanner(opts.model ?? 'claude-opus-5');
  if (provider === 'claude-cli') return new ClaudeCliPlanner(opts.model ?? 'claude-opus-5', { effort: opts.effort });
  throw new Error(`unknown planner provider "${provider}" (expected anthropic-api or claude-cli)`);
}
