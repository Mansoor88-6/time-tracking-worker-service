/** Application name recorded for OS lock/login surface segments after sanitization */
export const SYSTEM_IDLE_APPLICATION_SENTINEL = '__system_idle__';

const DEFAULT_DENY_NAMES = ['loginwindow', 'lockapp'];

/**
 * Parses optional comma-separated names from env and merges with built-in defaults (lowercase).
 */
export function buildSystemIdleDenySet(extraFromEnv?: string): Set<string> {
  const set = new Set<string>(DEFAULT_DENY_NAMES);
  if (!extraFromEnv?.trim()) {
    return set;
  }
  for (const part of extraFromEnv.split(',')) {
    const n = part.trim().toLowerCase();
    if (n) {
      set.add(n);
    }
  }
  return set;
}

function resolveWallDurationMs(event: {
  duration?: number;
  startTime?: number;
  endTime?: number;
}): number | null {
  if (event.duration !== undefined && event.duration > 0) {
    return event.duration;
  }
  if (
    event.startTime !== undefined &&
    event.endTime !== undefined &&
    event.endTime > event.startTime
  ) {
    return event.endTime - event.startTime;
  }
  return null;
}

function shouldConsiderForSystemIdle(source: undefined | 'browser' | 'app'): boolean {
  return source === undefined || source === 'app';
}

/**
 * Rewrites denylisted desktop events to pure idle semantics so timelines show idle
 * (not neutral) and app usage skips zero-active desktop rows.
 */
export function sanitizeSystemIdleRawEvents<
  T extends {
    application?: string;
    source?: 'browser' | 'app';
    duration?: number;
    startTime?: number;
    endTime?: number;
    activeDuration?: number;
    idleDuration?: number;
  },
>(events: T[], denySet: Set<string>): T[] {
  return events.map((event) => {
    if (!shouldConsiderForSystemIdle(event.source)) {
      return event;
    }
    const app = event.application?.trim().toLowerCase();
    if (!app || !denySet.has(app)) {
      return event;
    }
    const durationMs = resolveWallDurationMs(event);
    if (durationMs === null || durationMs <= 0) {
      return event;
    }
    return {
      ...event,
      application: SYSTEM_IDLE_APPLICATION_SENTINEL,
      duration: durationMs,
      activeDuration: 0,
      idleDuration: durationMs,
    };
  });
}
