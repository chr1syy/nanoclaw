import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createAdapter, type AgentAdapter, type Session, type SessionConfig, type SdkBackend } from '../sdk-adapter/index.js';

interface BenchmarkOptions {
  iterations: number;
  cwd: string;
  simplePrompt: string;
  toolPrompt: string;
  warmupRuns: number;
}

type ScenarioName =
  | 'Session creation'
  | 'Simple query'
  | 'Tool-heavy query'
  | 'Memory usage';

interface ScenarioResult {
  backend: SdkBackend;
  scenario: ScenarioName;
  iterations: number;
  averageMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  rssDeltaMb: number;
  heapDeltaMb: number;
  samplesMs: number[];
}

export const DEFAULT_OPTIONS: BenchmarkOptions = {
  iterations: parseInt(process.env.NANOCLAW_BENCHMARK_ITERATIONS || '3', 10),
  cwd: process.env.NANOCLAW_BENCHMARK_CWD || '/workspace/group',
  simplePrompt: process.env.NANOCLAW_BENCHMARK_SIMPLE_PROMPT || 'Respond with exactly: benchmark-ok',
  toolPrompt:
    process.env.NANOCLAW_BENCHMARK_TOOL_PROMPT
    || 'Use available tools to inspect the current directory and summarize what you find in two bullet points.',
  warmupRuns: parseInt(process.env.NANOCLAW_BENCHMARK_WARMUP || '1', 10),
};

export function toMb(bytes: number): number {
  return bytes / (1024 * 1024);
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function buildSessionConfig(cwd: string): SessionConfig {
  return {
    cwd,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    allowedTools: ['Bash', 'Read', 'Glob', 'Grep', 'mcp__*'],
  };
}

async function consumeQuery(
  adapter: AgentAdapter,
  session: Session,
  prompt: string,
): Promise<void> {
  for await (const _message of adapter.runQuery(session, prompt, {})) {
    // Consume stream fully so latency includes full backend processing.
  }
}

export async function runTimed(
  iterations: number,
  fn: () => Promise<void>,
): Promise<{ samplesMs: number[]; averageMs: number; p95Ms: number; minMs: number; maxMs: number }> {
  const samplesMs: number[] = [];

  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    await fn();
    samplesMs.push(performance.now() - started);
  }

  const total = samplesMs.reduce((acc, value) => acc + value, 0);

  return {
    samplesMs,
    averageMs: samplesMs.length > 0 ? total / samplesMs.length : 0,
    p95Ms: percentile(samplesMs, 95),
    minMs: samplesMs.length > 0 ? Math.min(...samplesMs) : 0,
    maxMs: samplesMs.length > 0 ? Math.max(...samplesMs) : 0,
  };
}

async function runScenario(
  backend: SdkBackend,
  scenario: ScenarioName,
  options: BenchmarkOptions,
  action: (adapter: AgentAdapter) => Promise<void>,
): Promise<ScenarioResult> {
  const adapter = createAdapter(backend);

  for (let i = 0; i < options.warmupRuns; i += 1) {
    await action(adapter);
  }

  if (typeof global.gc === 'function') {
    global.gc();
  }
  const memoryBefore = process.memoryUsage();

  const timing = await runTimed(options.iterations, async () => action(adapter));

  if (typeof global.gc === 'function') {
    global.gc();
  }
  const memoryAfter = process.memoryUsage();

  return {
    backend,
    scenario,
    iterations: options.iterations,
    averageMs: timing.averageMs,
    p95Ms: timing.p95Ms,
    minMs: timing.minMs,
    maxMs: timing.maxMs,
    rssDeltaMb: toMb(memoryAfter.rss - memoryBefore.rss),
    heapDeltaMb: toMb(memoryAfter.heapUsed - memoryBefore.heapUsed),
    samplesMs: timing.samplesMs,
  };
}

export function printResults(results: ScenarioResult[]): void {
  console.log('\nSDK Comparison Benchmark Results\n');

  const header = [
    'Backend'.padEnd(10),
    'Scenario'.padEnd(18),
    'Avg(ms)'.padStart(10),
    'P95(ms)'.padStart(10),
    'Min(ms)'.padStart(10),
    'Max(ms)'.padStart(10),
    'RSSΔ(MB)'.padStart(10),
    'HeapΔ(MB)'.padStart(10),
  ].join(' | ');

  console.log(header);
  console.log('-'.repeat(header.length));

  for (const result of results) {
    console.log([
      result.backend.padEnd(10),
      result.scenario.padEnd(18),
      result.averageMs.toFixed(2).padStart(10),
      result.p95Ms.toFixed(2).padStart(10),
      result.minMs.toFixed(2).padStart(10),
      result.maxMs.toFixed(2).padStart(10),
      result.rssDeltaMb.toFixed(2).padStart(10),
      result.heapDeltaMb.toFixed(2).padStart(10),
    ].join(' | '));
  }

  console.log('\nRaw samples per scenario:');
  for (const result of results) {
    console.log(`- ${result.backend}/${result.scenario}: [${result.samplesMs.map(v => v.toFixed(2)).join(', ')}]`);
  }
}

async function runBackendBenchmarks(backend: SdkBackend, options: BenchmarkOptions): Promise<ScenarioResult[]> {
  const config = buildSessionConfig(options.cwd);

  const sessionCreation = await runScenario(
    backend,
    'Session creation',
    options,
    async (adapter) => {
      await adapter.createSession(config);
    },
  );

  const simpleQuery = await runScenario(
    backend,
    'Simple query',
    options,
    async (adapter) => {
      const session = await adapter.createSession(config);
      await consumeQuery(adapter, session, options.simplePrompt);
    },
  );

  const toolHeavyQuery = await runScenario(
    backend,
    'Tool-heavy query',
    options,
    async (adapter) => {
      const session = await adapter.createSession(config);
      await consumeQuery(adapter, session, options.toolPrompt);
    },
  );

  const memoryUsage = await runScenario(
    backend,
    'Memory usage',
    options,
    async (adapter) => {
      const session = await adapter.createSession(config);
      await consumeQuery(adapter, session, options.simplePrompt);
      await consumeQuery(adapter, session, options.toolPrompt);
    },
  );

  return [sessionCreation, simpleQuery, toolHeavyQuery, memoryUsage];
}

export async function main(): Promise<void> {
  const options = DEFAULT_OPTIONS;

  if (Number.isNaN(options.iterations) || options.iterations < 1) {
    throw new Error(`Invalid NANOCLAW_BENCHMARK_ITERATIONS value: ${String(process.env.NANOCLAW_BENCHMARK_ITERATIONS)}`);
  }

  console.log('Running SDK benchmarks with options:');
  console.log(JSON.stringify({
    iterations: options.iterations,
    cwd: options.cwd,
    warmupRuns: options.warmupRuns,
  }, null, 2));

  const results: ScenarioResult[] = [];

  for (const backend of ['claude', 'opencode'] as const) {
    console.log(`\n[${backend}] starting benchmark suite...`);
    const backendResults = await runBackendBenchmarks(backend, options);
    results.push(...backendResults);
  }

  printResults(results);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`sdk-comparison benchmark failed: ${message}`);
    process.exitCode = 1;
  });
}
