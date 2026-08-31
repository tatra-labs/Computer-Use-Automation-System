#!/usr/bin/env node
/**
 * One-command demo: boots the target app, runs a real LLM discovery on the
 * lookup goal, then replays the resulting capability three times (success,
 * a different member, and an injected session-timeout fault) with no model
 * in the loop. Everything it does is also runnable by hand — see README.md
 * "Demo path" — this just sequences those same CLI commands and stops the
 * server for you afterward.
 */
import { spawn, ChildProcess } from 'node:child_process';

const APP_PORT = 8078;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    console.log(`\n$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'inherit'], shell: process.platform === 'win32' });
    let stdout = '';
    child.stdout.on('data', (d) => { const s = String(d); stdout += s; process.stdout.write(s); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/_health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`target app did not become healthy within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main(): Promise<void> {
  console.log('== handspan demo ==');
  console.log('1. start the target app, 2. real LLM discovery run, 3. deterministic replay x3\n');

  let app: ChildProcess | undefined;
  try {
    console.log(`Starting target app on ${APP_URL} ...`);
    app = spawn('npx', ['tsx', 'target-app/server.ts', `--port=${APP_PORT}`, '--variant=base'], {
      stdio: 'inherit', shell: process.platform === 'win32',
    });
    await waitForHealth(APP_URL, 15_000);
    console.log('Target app is up.');

    const discover = await run('npx', [
      'tsx', 'src/cli/index.ts', 'discover',
      '--goal', 'goals/lookup-member-savings-balance.json',
      '--model', 'claude-opus-5',
      '--run-id', `demo-${Date.now().toString(36)}`,
    ]);
    if (discover.code !== 0) throw new Error(`discovery exited ${discover.code}`);
    const artifactPath = discover.stdout.trim().split('\n').filter(Boolean).pop()!;
    console.log(`\nDiscovered capability → ${artifactPath}`);

    console.log('\n--- Replay 1: same member, deterministic success ---');
    await run('npx', ['tsx', 'src/cli/index.ts', 'replay', '--capability', artifactPath, '--input', 'memberId=12345']);

    console.log('\n--- Replay 2: a DIFFERENT member — proves the artifact is not pinned to the recording ---');
    await run('npx', ['tsx', 'src/cli/index.ts', 'replay', '--capability', artifactPath, '--input', 'memberId=23456']);

    console.log('\n--- Replay 3: an injected runtime fault (session timeout) — self-recovers via the app profile ---');
    await run('npx', ['tsx', 'src/cli/index.ts', 'replay', '--capability', artifactPath, '--input', 'memberId=12345', '--fault', 'session']);

    console.log('\n== demo complete. See evidence/ for full journals, screenshots, and the discovery transcript. ==');
  } finally {
    app?.kill();
  }
}

main().catch((e) => {
  console.error('\ndemo failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
