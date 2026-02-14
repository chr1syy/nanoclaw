import { describe, expect, it } from 'vitest';
import { percentile, runTimed, toMb } from '../benchmarks/sdk-comparison.js';

describe('sdk-comparison benchmark helpers', () => {
  it('converts bytes to MB', () => {
    expect(toMb(1024 * 1024)).toBe(1);
    expect(toMb(0)).toBe(0);
  });

  it('computes percentile from sorted positions', () => {
    expect(percentile([1, 2, 3, 4, 5], 95)).toBe(5);
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([], 95)).toBe(0);
  });

  it('captures timing samples for each iteration', async () => {
    let calls = 0;

    const result = await runTimed(3, async () => {
      calls += 1;
      await Promise.resolve();
    });

    expect(calls).toBe(3);
    expect(result.samplesMs).toHaveLength(3);
    expect(result.minMs).toBeGreaterThanOrEqual(0);
    expect(result.maxMs).toBeGreaterThanOrEqual(result.minMs);
    expect(result.averageMs).toBeGreaterThanOrEqual(0);
    expect(result.p95Ms).toBeGreaterThanOrEqual(0);
  });
});
