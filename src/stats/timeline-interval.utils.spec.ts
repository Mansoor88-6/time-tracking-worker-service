import {
  complementInRange,
  mergeMsIntervals,
  subtractMsIntervals,
} from './timeline-interval.utils';

describe('mergeMsIntervals', () => {
  it('merges overlapping and adjacent intervals', () => {
    expect(
      mergeMsIntervals([
        { startMs: 0, endMs: 100 },
        { startMs: 50, endMs: 150 },
        { startMs: 200, endMs: 250 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 150 },
      { startMs: 200, endMs: 250 },
    ]);
  });
});

describe('complementInRange', () => {
  it('returns full range when covered is empty', () => {
    expect(complementInRange(0, 300_000, [])).toEqual([
      { startMs: 0, endMs: 300_000 },
    ]);
  });

  it('returns gaps outside merged coverage', () => {
    const covered = [
      { startMs: 0, endMs: 60_000 },
      { startMs: 120_000, endMs: 180_000 },
    ];
    const slotMs = 300_000;
    expect(complementInRange(0, slotMs, covered)).toEqual([
      { startMs: 60_000, endMs: 120_000 },
      { startMs: 180_000, endMs: 300_000 },
    ]);
  });
});

describe('subtractMsIntervals', () => {
  it('returns base unchanged when toRemove is empty', () => {
    expect(
      subtractMsIntervals(
        [
          { startMs: 0, endMs: 100 },
          { startMs: 200, endMs: 250 },
        ],
        [],
      ),
    ).toEqual([
      { startMs: 0, endMs: 100 },
      { startMs: 200, endMs: 250 },
    ]);
  });

  it('fully removes an idle interval covered by a synthetic offline-approval', () => {
    const idle = [{ startMs: 60_000, endMs: 137_000 }]; // 1m17s idle
    const active = [{ startMs: 60_000, endMs: 137_000 }]; // same range, approved
    expect(subtractMsIntervals(idle, active)).toEqual([]);
  });

  it('keeps uncovered parts of idle when approval partially overlaps', () => {
    const idle = [{ startMs: 60_000, endMs: 180_000 }]; // 2m idle
    const active = [{ startMs: 60_000, endMs: 137_000 }]; // first 1m17s approved
    expect(subtractMsIntervals(idle, active)).toEqual([
      { startMs: 137_000, endMs: 180_000 },
    ]);
  });
});
