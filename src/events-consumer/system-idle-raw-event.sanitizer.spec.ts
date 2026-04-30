import {
  SYSTEM_IDLE_APPLICATION_SENTINEL,
  buildSystemIdleDenySet,
  sanitizeSystemIdleRawEvents,
} from './system-idle-raw-event.sanitizer';

describe('sanitizeSystemIdleRawEvents', () => {
  const deny = buildSystemIdleDenySet('');

  it('rewrites LockApp to full idle and sentinel application', () => {
    const out = sanitizeSystemIdleRawEvents(
      [
        {
          application: 'LockApp',
          source: 'app',
          duration: 60_000,
          timestamp: 1,
          status: 'active' as const,
        },
      ],
      deny,
    );
    expect(out).toHaveLength(1);
    expect(out[0].application).toBe(SYSTEM_IDLE_APPLICATION_SENTINEL);
    expect(out[0].activeDuration).toBe(0);
    expect(out[0].idleDuration).toBe(60_000);
    expect(out[0].duration).toBe(60_000);
  });

  it('rewrites loginwindow case-insensitively', () => {
    const out = sanitizeSystemIdleRawEvents(
      [
        {
          application: '  LoginWindow ',
          status: 'active' as const,
          duration: 120_000,
        },
      ],
      deny,
    );
    expect(out[0].application).toBe(SYSTEM_IDLE_APPLICATION_SENTINEL);
    expect(out[0].idleDuration).toBe(120_000);
    expect(out[0].activeDuration).toBe(0);
  });

  it('derives duration from startTime and endTime when duration missing', () => {
    const out = sanitizeSystemIdleRawEvents(
      [
        {
          application: 'lockapp',
          source: 'app',
          startTime: 1000,
          endTime: 5000,
        },
      ],
      deny,
    );
    expect(out[0].duration).toBe(4000);
    expect(out[0].idleDuration).toBe(4000);
    expect(out[0].activeDuration).toBe(0);
  });

  it('does not touch browser source events even if name matches', () => {
    const ev = {
      application: 'lockapp',
      source: 'browser' as const,
      duration: 5000,
    };
    const out = sanitizeSystemIdleRawEvents([ev], deny)[0];
    expect(out).toBe(ev);
    expect(out.application).toBe('lockapp');
  });

  it('does not touch unrelated apps', () => {
    const ev = {
      application: 'Code',
      duration: 1000,
      source: 'app' as const,
    };
    const out = sanitizeSystemIdleRawEvents([ev], deny)[0];
    expect(out).toBe(ev);
  });

  it('leaves denylisted rows unchanged when duration cannot be resolved', () => {
    const ev = {
      application: 'LockApp',
      source: 'app' as const,
    };
    const out = sanitizeSystemIdleRawEvents([ev], deny)[0];
    expect(out).toBe(ev);
  });

  it('merges env extra names into deny set', () => {
    const set = buildSystemIdleDenySet('ScreenSaver, FooApp');
    expect(set.has('loginwindow')).toBe(true);
    expect(set.has('lockapp')).toBe(true);
    expect(set.has('screensaver')).toBe(true);
    expect(set.has('fooapp')).toBe(true);
    const out = sanitizeSystemIdleRawEvents(
      [{ application: 'FooApp', duration: 100, source: 'app' as const }],
      set,
    );
    expect(out[0].application).toBe(SYSTEM_IDLE_APPLICATION_SENTINEL);
  });
});
