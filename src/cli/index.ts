#!/usr/bin/env node
/**
 * One entry point for every path through the system: discover a capability,
 * replay one, browse the catalog, invoke by name, approve, measure stability,
 * or run the operator console on its own.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadCapability, loadOverlay, loadProfile, specialize } from '../core/load.js';
import type { Capability } from '../core/artifact.js';
import { summarize as summarizeResult, ReplayResult } from '../core/result.js';
import { PolicyGate } from '../policy/policy.js';
import { Redactor } from '../policy/redact.js';
import { Journal } from '../obs/journal.js';
import { Session, SessionRegistry } from '../session/session.js';
import { WebSurface } from '../surface/web/web-surface.js';
import { InterventionStore } from '../escalation/intervention.js';
import { Escalator } from '../escalation/escalator.js';
import { OperatorConsole } from '../escalation/operator-console.js';
import { approveRiskyStep, completeLookupManually, OperatorPlaybook, ScriptedOperator } from '../escalation/scripted-operator.js';
import { replay } from '../replay/engine.js';
import { discover } from '../agent/discover.js';
import { compileCapability } from '../agent/compile.js';
import { loadGoalSpec } from '../agent/goal.js';
import { selectPlanner } from '../agent/planner.js';
import { findByName, loadCatalog, summarize as summarizeCap, toToolDefinition } from '../catalog/catalog.js';

const CAP_DIR = 'capabilities';
const EVIDENCE_DIR = 'evidence';
const POLICY_PATH = 'policy/policy.json';

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

interface Args {
  cmd: string;
  positional: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const cmd = argv[0] ?? 'help';
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      const key = k!;
      const next = inline ?? (argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i] : 'true');
      const cur = flags.get(key) ?? [];
      cur.push(next!);
      flags.set(key, cur);
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, flags };
}

const one = (a: Args, k: string, d?: string): string | undefined => a.flags.get(k)?.[0] ?? d;
const many = (a: Args, k: string): string[] => a.flags.get(k) ?? [];
const bool = (a: Args, k: string): boolean => a.flags.has(k) && one(a, k) !== 'false';

function kvInputs(a: Args): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of many(a, 'input')) {
    const i = pair.indexOf('=');
    if (i < 0) throw new Error(`--input expects key=value, got "${pair}"`);
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

/** Minimal .env support so credentials stay out of the repo and out of argv. */
function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2]!.trim().replace(/^["']|["']$/g, '');
    if (!(m[1]! in process.env)) process.env[m[1]!] = v;
  }
}

// ---------------------------------------------------------------------------
// run scaffolding
// ---------------------------------------------------------------------------

interface Rig {
  session: Session;
  surface: WebSurface;
  journal: Journal;
  gate: PolicyGate;
  redactor: Redactor;
  registry: SessionRegistry;
  store: InterventionStore;
  escalator?: Escalator;
  console?: OperatorConsole;
  detachOperator?: () => void;
  dispose(): Promise<void>;
}

async function buildRig(opts: {
  mode: 'discovery' | 'replay';
  runId: string;
  goal?: string;
  capability?: string;
  tenant?: string | null;
  headed: boolean;
  consolePort?: number;
  operatorSim?: OperatorPlaybook;
  escalationWaitMs: number;
  withEscalation: boolean;
}): Promise<Rig> {
  const gate = PolicyGate.fromFile(POLICY_PATH);
  const redactor = new Redactor(gate.policy.redaction.extraPatterns);
  // Whatever the app's credentials are, they must never appear in evidence.
  redactor.registerValue(process.env.TARGET_APP_PASSWORD, 'secret');
  redactor.registerValue(process.env.TARGET_APP_USER, 'secret');

  const journal = new Journal(EVIDENCE_DIR, {
    runId: opts.runId, mode: opts.mode, goal: opts.goal,
    capability: opts.capability, tenant: opts.tenant ?? null,
  }, redactor);

  const surface = await WebSurface.launch({ headless: !opts.headed });
  const session = new Session({ surface, gate, redactor, journal, holder: `${opts.mode}:${opts.runId}` });

  const registry = new SessionRegistry();
  const unregister = registry.register(session);
  const store = new InterventionStore(join(EVIDENCE_DIR, 'interventions'));

  let escalator: Escalator | undefined;
  let consoleSrv: OperatorConsole | undefined;
  let detachOperator: (() => void) | undefined;

  if (opts.withEscalation) {
    escalator = new Escalator(store, { waitMs: opts.escalationWaitMs });
    if (opts.consolePort) {
      consoleSrv = new OperatorConsole(
        { store, resolveSession: (id) => registry.resolveSession(id) },
        { port: opts.consolePort },
      );
      const { url } = await consoleSrv.start();
      process.stderr.write(`[operator] console listening on ${url}\n`);
    }
    if (opts.operatorSim) {
      detachOperator = new ScriptedOperator(store, (id) => registry.resolveSession(id), opts.operatorSim).attach();
      process.stderr.write(`[operator] scripted operator attached (simulating a duty officer)\n`);
    }
  }

  return {
    session, surface, journal, gate, redactor, registry, store, escalator,
    console: consoleSrv, detachOperator,
    async dispose() {
      detachOperator?.();
      await consoleSrv?.stop();
      unregister();
      await session.close();
    },
  };
}

function pickPlaybook(name: string | undefined, inputs: Record<string, string>): OperatorPlaybook | undefined {
  if (!name || name === 'none') return undefined;
  if (name === 'approve') return approveRiskyStep;
  if (name === 'manual-fix') return completeLookupManually(inputs.memberId ?? '12345');
  throw new Error(`unknown --operator-sim "${name}" (expected approve, manual-fix, or none)`);
}

/** Fault injection against the target app's test-only control plane. */
async function injectFault(entry: string, mode: string): Promise<void> {
  const origin = new URL(entry).origin;
  const res = await fetch(`${origin}/_fault`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `mode=${encodeURIComponent(mode)}&once=true`,
  });
  process.stderr.write(`[fault] ${mode} armed on ${origin} → ${await res.text()}\n`);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdDiscover(a: Args): Promise<number> {
  const goalPath = one(a, 'goal');
  if (!goalPath) throw new Error('--goal <goalspec.json> is required');
  const spec = loadGoalSpec(goalPath);
  const profile = loadProfile(spec.profile);
  const runId = one(a, 'run-id') ?? randomUUID().slice(0, 8);

  const planner = selectPlanner({
    provider: one(a, 'planner'),
    model: one(a, 'model'),
    effort: one(a, 'effort'),
  });
  process.stderr.write(`[discover] planner=${planner.id} model=${planner.model} goal="${spec.goal}"\n`);

  const rig = await buildRig({
    mode: 'discovery', runId, goal: spec.goal, capability: spec.name,
    headed: bool(a, 'headed'),
    consolePort: one(a, 'console') ? Number(one(a, 'console')) : undefined,
    operatorSim: pickPlaybook(one(a, 'operator-sim'), {}),
    escalationWaitMs: Number(one(a, 'escalation-wait', '180000')),
    withEscalation: true,
  });

  try {
    const outcome = await discover({
      goal: spec.goal,
      entry: spec.entry,
      productTitle: profile.title,
      profile,
      params: spec.params.map((p) => ({
        name: p.name, type: p.type, description: p.description,
        sensitivity: p.sensitivity, value: p.value,
      })),
      maxSteps: spec.maxSteps,
    }, { session: rig.session, planner, escalator: rig.escalator });

    process.stderr.write(`[discover] status=${outcome.status} llmCalls=${outcome.llmCalls} actions=${outcome.recorded.length}\n`);
    if (outcome.reason) process.stderr.write(`[discover] ${outcome.reason}\n`);

    rig.journal.writeJson('discovery-outcome.json', {
      status: outcome.status, reason: outcome.reason, llmCalls: outcome.llmCalls,
      humanAssisted: outcome.humanAssisted, successText: outcome.successText,
      recorded: outcome.recorded, outputs: outcome.outputs,
    });

    if (outcome.status !== 'success') {
      rig.journal.end({ status: outcome.status, reason: outcome.reason });
      return 2;
    }

    const { capability, warnings } = compileCapability({
      spec, outcome, redactor: rig.redactor,
      provenance: {
        runId, plannerProvider: planner.id, model: planner.model,
        discoveredAt: new Date().toISOString(),
      },
    });

    for (const w of warnings) process.stderr.write(`[compile] WARNING ${w}\n`);

    const out = one(a, 'out') ?? join(CAP_DIR, `${spec.name}.json`);
    // The artifact is NOT redacted: it must be exact to replay. The compiler is
    // what guarantees no regulated value ever reaches it.
    writeFileSync(out, JSON.stringify(capability, null, 2) + '\n', 'utf8');
    rig.journal.writeJson('artifact.json', capability, { redact: false });
    rig.journal.event('artifact.emit', { path: out, steps: capability.steps.length, warnings });
    rig.journal.end({ status: 'success', artifact: out });

    process.stdout.write(`${out}\n`);
    process.stderr.write(`[discover] wrote ${out} (${capability.steps.length} steps, ${capability.contract.outputs.length} outputs, approval=${capability.approval.state})\n`);
    return 0;
  } finally {
    await rig.dispose();
  }
}

async function loadForReplay(a: Args): Promise<{ capability: Capability; profile?: ReturnType<typeof loadProfile>; tenant: string | null; path: string; notes: string[] }> {
  const path = one(a, 'capability') ?? (one(a, 'name') ? findByName(CAP_DIR, one(a, 'name')!).path : undefined);
  if (!path) throw new Error('--capability <file.json> or --name <capability_name> is required');
  const base = loadCapability(path);
  const profile = loadProfile(base.app.profile);
  const overlayPath = one(a, 'tenant');
  const overlay = overlayPath ? loadOverlay(overlayPath) : undefined;
  const sp = specialize(base, profile, overlay);
  return { capability: sp.capability, profile: sp.profile, tenant: sp.tenant, path, notes: sp.notes };
}

async function runOneReplay(a: Args, runId: string): Promise<{ result: ReplayResult; path: string }> {
  const { capability, profile, tenant, path, notes } = await loadForReplay(a);
  for (const n of notes) process.stderr.write(`[tenant:${tenant}] ${n}\n`);

  const inputs = kvInputs(a);
  const fault = one(a, 'fault');
  if (fault) await injectFault(capability.app.entry, fault);

  const rig = await buildRig({
    mode: 'replay', runId, capability: capability.name, tenant,
    headed: bool(a, 'headed'),
    consolePort: one(a, 'console') ? Number(one(a, 'console')) : undefined,
    operatorSim: pickPlaybook(one(a, 'operator-sim'), inputs),
    escalationWaitMs: Number(one(a, 'escalation-wait', '180000')),
    withEscalation: bool(a, 'escalate') || !!one(a, 'operator-sim') || !!one(a, 'console'),
  });

  try {
    const result = await replay({
      capability, profile, tenant, inputs,
      unattended: bool(a, 'unattended'),
      confirmed: bool(a, 'confirm'),
    }, { session: rig.session, escalator: rig.escalator });

    rig.journal.writeJson('result.json', result, { redact: false });
    rig.journal.end({ status: result.status, code: result.failure?.code ?? result.outcome?.code });
    return { result, path };
  } finally {
    await rig.dispose();
  }
}

async function cmdReplay(a: Args): Promise<number> {
  const runId = one(a, 'run-id') ?? randomUUID().slice(0, 8);
  const { result, path } = await runOneReplay(a, runId);

  if (bool(a, 'record-stability')) recordStability(path, result);

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.stderr.write(`\n[replay] ${summarizeResult(result)}\n[replay] evidence → ${result.evidence.dir}\n`);
  return result.status === 'success' || result.status === 'business_outcome' ? 0 : 3;
}

function recordStability(path: string, result: ReplayResult): void {
  const cap = loadCapability(path);
  const replays = cap.stability.replays + 1;
  const successes = cap.stability.successes + (result.status === 'success' ? 1 : 0);
  const next: Capability = {
    ...cap,
    stability: {
      replays, successes,
      lastReplayAt: new Date().toISOString(),
      successRate: Math.round((successes / replays) * 1000) / 1000,
    },
  };
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

async function cmdStability(a: Args): Promise<number> {
  const runs = Number(one(a, 'runs', '3'));
  const results: ReplayResult[] = [];
  for (let i = 1; i <= runs; i++) {
    process.stderr.write(`\n[stability] run ${i}/${runs}\n`);
    const { result, path } = await runOneReplay(a, `stab${i}-${randomUUID().slice(0, 6)}`);
    results.push(result);
    recordStability(path, result);
    process.stderr.write(`[stability] run ${i}: ${summarizeResult(result)}\n`);
  }

  const successes = results.filter((r) => r.status === 'success').length;
  const outputsSeen = new Set(results.filter((r) => r.status === 'success').map((r) => JSON.stringify(r.outputs)));
  const report = {
    runs, successes,
    successRate: Math.round((successes / runs) * 1000) / 1000,
    // Same inputs must produce byte-identical outputs; more than one distinct
    // shape across runs means the flow is not actually deterministic.
    distinctOutputShapes: outputsSeen.size,
    deterministic: outputsSeen.size <= 1,
    statuses: results.map((r) => r.status),
    durationsMs: results.map((r) => r.timing.durationMs),
    evidence: results.map((r) => r.evidence.dir),
  };
  writeFileSync(join(EVIDENCE_DIR, 'stability.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return successes === runs ? 0 : 3;
}

function cmdCatalog(a: Args): number {
  const entries = loadCatalog(CAP_DIR);
  if (bool(a, 'tools')) {
    // Exactly what you would hand an LLM as its tool list.
    process.stdout.write(JSON.stringify(entries.map((e) => toToolDefinition(e.capability)), null, 2) + '\n');
    return 0;
  }
  if (bool(a, 'json')) {
    process.stdout.write(JSON.stringify(entries.map(summarizeCap), null, 2) + '\n');
    return 0;
  }
  if (entries.length === 0) {
    process.stdout.write(`no capabilities in ${CAP_DIR}/ — run "npm run cua -- discover --goal goals/<spec>.json" first\n`);
    return 0;
  }
  for (const e of entries) {
    const s = summarizeCap(e);
    process.stdout.write(
      `${s.name}  v${s.version}  [${s.approval}${s.unattended ? ', unattended-ok' : ', attended-only'}]\n` +
      `  ${s.title}\n` +
      `  product=${s.product} variant=${s.variant} risks=${s.risks.join(',')}\n` +
      `  in (${s.inputs.join(', ') || 'none'})  out (${s.outputs.join(', ') || 'none'})\n` +
      `  replays=${s.stability.replays} successRate=${s.stability.successRate ?? 'n/a'}  ${s.path}\n\n`,
    );
  }
  return 0;
}

async function cmdInvoke(a: Args): Promise<number> {
  const name = a.positional[0] ?? one(a, 'name');
  if (!name) throw new Error('usage: invoke <capability_name> --input k=v ...');
  const entry = findByName(CAP_DIR, name);
  process.stderr.write(`[invoke] ${entry.capability.name}@v${entry.capability.version} → ${entry.path}\n`);
  a.flags.set('capability', [entry.path]);
  return cmdReplay(a);
}

function cmdApprove(a: Args): number {
  const path = one(a, 'capability') ?? (one(a, 'name') ? findByName(CAP_DIR, one(a, 'name')!).path : undefined);
  if (!path) throw new Error('--capability <file.json> or --name <capability_name> is required');
  const by = one(a, 'by');
  if (!by) throw new Error('--by <reviewer> is required: approval is an accountable act');
  const cap = loadCapability(path);
  if (cap.provenance.humanAssistedSteps.length > 0 && !bool(a, 'force')) {
    process.stderr.write(
      `[approve] refusing: discovery needed human help at [${cap.provenance.humanAssistedSteps.join(', ')}] ` +
      `so the recording has gaps. Review and re-record, or pass --force.\n`,
    );
    return 4;
  }
  const next: Capability = {
    ...cap,
    approval: {
      state: bool(a, 'revoke') ? 'revoked' : 'approved',
      by, at: new Date().toISOString(),
      note: one(a, 'note') ?? 'reviewed steps, locators, checkpoints and declared outcomes',
    },
  };
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8');
  process.stdout.write(`${cap.name} → ${next.approval.state} by ${by}\n`);
  return 0;
}

async function cmdOperator(a: Args): Promise<number> {
  const port = Number(one(a, 'port', '8090'));
  const store = new InterventionStore(join(EVIDENCE_DIR, 'interventions'));
  const registry = new SessionRegistry();
  const srv = new OperatorConsole({ store, resolveSession: (id) => registry.resolveSession(id) }, { port });
  const { url } = await srv.start();
  process.stdout.write(
    `operator console on ${url}\n` +
    `NOTE: run in this mode it can read interventions written to ${EVIDENCE_DIR}/interventions by past runs,\n` +
    `but it holds no live sessions. To take control of a live run, start the run with --console ${port}.\n`,
  );
  await new Promise(() => undefined); // serve until interrupted
  return 0;
}

const HELP = `handspan — computer-use automation: discover once with an LLM, replay deterministically

  discover   --goal goals/x.json [--planner anthropic-api|claude-cli] [--model M] [--effort L]
             [--headed] [--out capabilities/x.json] [--console PORT] [--operator-sim approve]

  replay     --capability capabilities/x.json | --name <capability_name>
             [--input k=v ...] [--tenant tenants/y.json] [--confirm] [--unattended]
             [--headed] [--fault slow|interstitial|session|error500|validation]
             [--console PORT] [--operator-sim approve|manual-fix] [--escalate]
             [--record-stability]

  invoke     <capability_name> --input k=v ...          call a capability by name
  catalog    [--json] [--tools]                         list capabilities / emit tool defs
  approve    --name <n> --by <reviewer> [--note N] [--revoke] [--force]
  stability  --capability F --runs N --input k=v ...    replay N times, report flakiness
  operator   [--port 8090]                              operator console only

The target app must be running:  npm run app   (and npm run app:riverbend for tenant 2)
`;

async function main(): Promise<number> {
  loadDotEnv();
  const a = parseArgs(process.argv.slice(2));
  switch (a.cmd) {
    case 'discover': return cmdDiscover(a);
    case 'replay': return cmdReplay(a);
    case 'invoke': return cmdInvoke(a);
    case 'catalog': return cmdCatalog(a);
    case 'approve': return cmdApprove(a);
    case 'stability': return cmdStability(a);
    case 'operator': return cmdOperator(a);
    default:
      process.stdout.write(HELP);
      return a.cmd === 'help' || a.cmd === '--help' ? 0 : 1;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`\nerror: ${e instanceof Error ? e.message : String(e)}\n`);
    if (process.env.HANDSPAN_DEBUG) process.stderr.write(String(e instanceof Error ? e.stack : '') + '\n');
    process.exit(1);
  },
);
