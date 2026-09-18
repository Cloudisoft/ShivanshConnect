import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetSmsDispatcherCountersForTests, perMinuteRemaining, recordSend } from './smsDispatcher.js';

/**
 * The rolling per-campaign per-minute counter is the exact same technique
 * campaignDispatcher.ts's perMinuteCounters uses for calls-per-minute
 * (Phase 7) - tested here once for the SMS dispatcher's copy of the
 * logic; emailDispatcher.ts's identical counter is exercised indirectly
 * through the messaging integration test's throttled sends.
 */
describe('smsDispatcher throttle/rolling-counter math', () => {
  afterEach(() => {
    __resetSmsDispatcherCountersForTests();
    vi.useRealTimers();
  });

  it('starts a fresh campaign with the full limit available', () => {
    expect(perMinuteRemaining('camp-1', 10)).toBe(10);
  });

  it('decrements remaining capacity as sends are recorded', () => {
    perMinuteRemaining('camp-2', 5);
    recordSend('camp-2');
    recordSend('camp-2');
    expect(perMinuteRemaining('camp-2', 5)).toBe(3);
  });

  it('never goes negative once the limit is exceeded', () => {
    perMinuteRemaining('camp-3', 1);
    recordSend('camp-3');
    recordSend('camp-3');
    recordSend('camp-3');
    expect(perMinuteRemaining('camp-3', 1)).toBe(0);
  });

  it('resets the window after 60 seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    perMinuteRemaining('camp-4', 3);
    recordSend('camp-4');
    recordSend('camp-4');
    expect(perMinuteRemaining('camp-4', 3)).toBe(1);

    vi.setSystemTime(new Date('2026-01-01T00:01:01.000Z'));
    expect(perMinuteRemaining('camp-4', 3)).toBe(3);
  });

  it('tracks separate campaigns independently', () => {
    recordSend('camp-a');
    expect(perMinuteRemaining('camp-a', 5)).toBe(4);
    expect(perMinuteRemaining('camp-b', 5)).toBe(5);
  });
});
