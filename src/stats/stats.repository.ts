import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { RawEventEntity } from '../timescale/entities/raw-event.entity';
import type { DashboardStats } from './interfaces/dashboard-stats.interface';
import type { RawAppUsage, UrlBreakdown } from './interfaces/app-usage.interface';
import { AppCategorizationService } from './app-categorization.service';
import {
  complementInRange,
  mergeMsIntervals,
  subtractMsIntervals,
  type MsInterval,
} from './timeline-interval.utils';

export interface TimelineIntervalIsoDto {
  start: string;
  end: string;
}

export interface TimelineSlotActivityDto {
  label: string;
  durationMs: number;
  category: 'productive' | 'neutral' | 'unproductive';
}

export interface TimelineSlotDto {
  startMinuteFromMidnight: number;
  /** ISO 8601 instant for the start of this 5-minute bucket (stable across multi-day ranges). */
  slotStartUtc: string;
  productivePct: number;
  neutralPct: number;
  unproductivePct: number;
  /** Fraction of the 5-minute slot that was idle/away (0–1). */
  idlePct: number;
  /** Idle portion of the slot in milliseconds. */
  idleMs: number;
  online: boolean;
  /** Per-app/site active time in this slot (for tooltips). */
  activities?: TimelineSlotActivityDto[];
  /**
   * Wall-clock intervals of productive+neutral+unproductive (blocked in offline modal).
   * Always present (possibly empty) on new workers so clients can detect interval-aware payloads.
   */
  activeIntervalsUtc: TimelineIntervalIsoDto[];
  /** Wall-clock idle/away intervals within the slot. */
  idleIntervalsUtc: TimelineIntervalIsoDto[];
  /**
   * Uncovered wall time in the slot (no tracked active or idle).
   * Empty array when offline or fully covered.
   */
  remainderIntervalsUtc: TimelineIntervalIsoDto[];
}

/**
 * Minutes from local midnight for an instant, in the given IANA timezone.
 * Day boundaries from getDayBoundaries use this same timezone; using UTC here
 * made tooltips (and labels) disagree with the timeline.
 */
function minutesFromMidnightInTimezone(
  instant: Date,
  timeZone?: string,
): number {
  if (!timeZone) {
    return instant.getUTCHours() * 60 + instant.getUTCMinutes();
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(instant);
  let hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  if (hour === 24) hour = 0;
  return hour * 60 + minute;
}

/** Display label for timeline tooltip rows (browser domains, titles, or app name). */
function timelineActivityDisplayLabel(e: RawEventEntity): string {
  const webSource = e.source === 'browser';
  const app = e.application?.trim();
  const url = e.url?.trim();
  const title = e.title?.trim();
  if (webSource) {
    if (url) {
      try {
        if (url.startsWith('http://') || url.startsWith('https://')) {
          return new URL(url).hostname.replace(/^www\./, '');
        }
      } catch {
        /* ignore invalid URL */
      }
      const host = url.split('/')[0]?.replace(/^www\./, '');
      if (host) return host;
    }
    if (title) return title.length > 50 ? `${title.slice(0, 47)}...` : title;
    return app || 'Browser';
  }
  return app || 'Unknown';
}

function appendSlotInterval(
  map: Map<number, MsInterval[]>,
  slotIndex: number,
  startMs: number,
  endMs: number,
): void {
  if (endMs - startMs < 1) return;
  const arr = map.get(slotIndex) ?? [];
  arr.push({ startMs, endMs });
  map.set(slotIndex, arr);
}

function msIntervalsToIso(
  intervals: MsInterval[],
): TimelineIntervalIsoDto[] {
  return intervals.map(({ startMs, endMs }) => ({
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  }));
}

/** YYYY-MM-DD for the instant in the given IANA zone (or UTC calendar day if tz omitted). */
export function instantToLocalDateKey(
  instant: Date,
  timeZone?: string,
): string {
  if (!timeZone) {
    const y = instant.getUTCFullYear();
    const m = instant.getUTCMonth() + 1;
    const d = instant.getUTCDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

export type DailyDashboardStatsRow = { date: string } & DashboardStats;

/**
 * Stats Repository
 *
 * Handles efficient aggregation queries on TimescaleDB raw_events table.
 * Uses indexed columns (tenant_id, user_id, time) for optimal performance.
 */
@Injectable()
export class StatsRepository {
  private readonly logger = new Logger(StatsRepository.name);

  constructor(
    @InjectRepository(RawEventEntity)
    private readonly rawEventRepository: Repository<RawEventEntity>,
    private readonly appCategorizationService: AppCategorizationService,
  ) {}

  /**
   * Build dashboard stats from raw events (single local day bucket or any range).
   */
  private buildDashboardStatsFromEvents(
    events: RawEventEntity[],
    activityWindowSec: number = 600,
  ): DashboardStats {
    if (events.length === 0) {
      return this.getEmptyStats();
    }

    const nonOfflineEvents = events.filter((e) => e.status !== 'offline');

    const toNumber = (
      value: bigint | number | string | null | undefined,
    ): number => {
      if (value === null || value === undefined) return 0;
      if (typeof value === 'number') return value;
      if (typeof value === 'bigint') return Number(value);
      if (typeof value === 'string') {
        const parsed = parseInt(value, 10);
        return isNaN(parsed) ? 0 : parsed;
      }
      return 0;
    };

    /** Same wall-clock bounds as timeline slotting (`getTimelineSlots`). */
    const wallClockStartMs = (e: RawEventEntity): number =>
      e.startTime !== null && e.startTime !== undefined
        ? toNumber(e.startTime)
        : e.time.getTime();
    const wallClockEndMs = (e: RawEventEntity): number =>
      e.endTime !== null && e.endTime !== undefined
        ? toNumber(e.endTime)
        : wallClockStartMs(e) + toNumber(e.durationMs);

    const now = new Date();
    const nowMs = now.getTime();

    let firstPresenceStartMs = Infinity;
    let lastPresenceEndMs = 0;
    for (const e of nonOfflineEvents) {
      const s = wallClockStartMs(e);
      const end = wallClockEndMs(e);
      if (s < firstPresenceStartMs) firstPresenceStartMs = s;
      if (end > lastPresenceEndMs) lastPresenceEndMs = end;
    }

    const arrivalTime =
      firstPresenceStartMs !== Infinity
        ? new Date(firstPresenceStartMs)
        : null;

    /**
     * "Online" = last tracked presence end is within the activity window of now
     * (uses end time, not event start — matches synthetic offline-approval segments).
     */
    const cappedEndForPresenceMs = Math.min(lastPresenceEndMs, nowMs);
    const isOnline: boolean =
      lastPresenceEndMs > 0 &&
      nowMs - cappedEndForPresenceMs < activityWindowSec * 1000;

    const leftTime =
      isOnline || lastPresenceEndMs <= 0
        ? null
        : new Date(Math.min(lastPresenceEndMs, nowMs));

    const getActiveDuration = (e: RawEventEntity): number => {
      if (e.activeDurationMs !== null && e.activeDurationMs !== undefined) {
        return toNumber(e.activeDurationMs);
      }
      return toNumber(e.durationMs);
    };

    const productiveTimeMs = events
      .filter((e) => e.status === 'active')
      .reduce((sum, e) => sum + getActiveDuration(e), 0);

    const deskTimeMs = events
      .filter(
        (e) =>
          e.status === 'active' ||
          e.status === 'idle' ||
          e.status === 'away',
      )
      .reduce((sum, e) => sum + toNumber(e.durationMs), 0);

    let timeAtWorkMs = 0;
    if (arrivalTime) {
      let endTime: Date;
      if (isOnline) {
        endTime = now;
      } else if (lastPresenceEndMs > 0) {
        endTime = new Date(Math.min(lastPresenceEndMs, nowMs));
      } else {
        endTime = now;
      }
      timeAtWorkMs = Math.max(0, endTime.getTime() - arrivalTime.getTime());
    }

    const projectsTimeMs = events
      .filter(
        (e) =>
          e.status === 'active' &&
          e.projectId !== null &&
          e.projectId !== undefined &&
          (e.activeDurationMs !== null && e.activeDurationMs !== undefined
            ? true
            : !!e.durationMs),
      )
      .reduce((sum, e) => sum + getActiveDuration(e), 0);

    const productivityScorePct =
      deskTimeMs > 0 ? Math.round((productiveTimeMs / deskTimeMs) * 100) : 0;
    const effectivenessPct =
      timeAtWorkMs > 0
        ? Math.round((productiveTimeMs / timeAtWorkMs) * 100)
        : 0;

    return {
      arrivalTime,
      leftTime,
      isOnline,
      productiveTimeMs,
      deskTimeMs,
      timeAtWorkMs,
      productivityScorePct: Math.min(100, Math.max(0, productivityScorePct)),
      effectivenessPct: Math.min(100, Math.max(0, effectivenessPct)),
      projectsTimeMs,
    };
  }

  /**
   * Get dashboard stats for a user within a time range
   *
   * @param tenantId - Tenant ID
   * @param userId - User ID
   * @param startTime - Start of time range (UTC)
   * @param endTime - End of time range (UTC)
   * @param activityWindowSec - Seconds to consider user "online" after last activity (default: 600)
   * @returns Aggregated dashboard statistics
   */
  async getDashboardStats(
    tenantId: number,
    userId: number,
    startTime: Date,
    endTime: Date,
    activityWindowSec: number = 600,
  ): Promise<DashboardStats> {
    const queryStart = Date.now();


    try {
      const events = await this.rawEventRepository.find({
        where: {
          tenantId,
          userId,
          time: Between(startTime, endTime),
        },
        order: {
          time: 'ASC',
        },
      });

      this.logger.log(
        `Found ${events.length} event(s) in range ${startTime.toISOString()} to ${endTime.toISOString()}`,
      );
      if (events.length > 0) {
        this.logger.debug(
          `Event IDs: ${events.map((e) => e.id).join(', ')}`,
        );
        this.logger.debug(
          `Event times: ${events.map((e) => e.time.toISOString()).join(', ')}`,
        );
      } else {
        this.logger.log('No events found, returning empty stats');
      }

      const stats = this.buildDashboardStatsFromEvents(
        events,
        activityWindowSec,
      );

      const queryDuration = Date.now() - queryStart;
      this.logger.log(
        `✅ Stats query completed in ${queryDuration}ms for tenant ${tenantId}, user ${userId}`,
      );

      return stats;
    } catch (error) {
      const queryDuration = Date.now() - queryStart;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `❌ Stats query failed after ${queryDuration}ms for tenant ${tenantId}, user ${userId}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Per-local-day stats for a calendar range (one query, bucket by tz).
   */
  async getDashboardStatsPerDay(
    tenantId: number,
    userId: number,
    rangeStartUtc: Date,
    rangeEndUtc: Date,
    orderedDayKeys: string[],
    timeZone?: string,
    activityWindowSec: number = 600,
  ): Promise<DailyDashboardStatsRow[]> {
    const queryStart = Date.now();
    try {
      const events = await this.rawEventRepository.find({
        where: {
          tenantId,
          userId,
          time: Between(rangeStartUtc, rangeEndUtc),
        },
        order: { time: 'ASC' },
      });

      this.logger.log(
        `Month overview: ${events.length} events, UTC ${rangeStartUtc.toISOString()}–${rangeEndUtc.toISOString()}, ${orderedDayKeys.length} day(s)`,
      );

      const byDay = new Map<string, RawEventEntity[]>();
      for (const e of events) {
        const key = instantToLocalDateKey(e.time, timeZone);
        const arr = byDay.get(key) ?? [];
        arr.push(e);
        byDay.set(key, arr);
      }

      const rows: DailyDashboardStatsRow[] = orderedDayKeys.map((date) => ({
        date,
        ...this.buildDashboardStatsFromEvents(
          byDay.get(date) ?? [],
          activityWindowSec,
        ),
      }));

      this.logger.log(
        `✅ Month overview query completed in ${Date.now() - queryStart}ms`,
      );
      return rows;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `❌ Month overview stats failed: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Latest event timestamp per user in tenant within a recent window (for colleague presence).
   */
  async getLastActivityPerUserInWindow(
    tenantId: number,
    sinceUtc: Date,
  ): Promise<Map<number, Date>> {
    const rows = await this.rawEventRepository
      .createQueryBuilder('e')
      .select('e.userId', 'userId')
      .addSelect('MAX(e.time)', 'lastTime')
      .where('e.tenantId = :tenantId', { tenantId })
      .andWhere('e.time >= :since', { since: sinceUtc })
      .groupBy('e.userId')
      .getRawMany<{ userId: string; lastTime: Date | string }>();

    const map = new Map<number, Date>();
    for (const row of rows) {
      const uid = Number(row.userId);
      const t =
        row.lastTime instanceof Date
          ? row.lastTime
          : new Date(row.lastTime);
      if (!Number.isNaN(uid) && !Number.isNaN(t.getTime())) {
        map.set(uid, t);
      }
    }
    return map;
  }

  /**
   * Merge overlapping intervals to calculate total wall-clock time
   */
  private mergeIntervals(
    intervals: Array<{ start: number; end: number }>,
  ): Array<{ start: number; end: number }> {
    if (intervals.length === 0) return [];

    // Sort by start time
    const sorted = intervals.sort((a, b) => a.start - b.start);

    const merged: Array<{ start: number; end: number }> = [];
    let current = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];

      // If intervals overlap or are adjacent, merge them
      if (next.start <= current.end) {
        current.end = Math.max(current.end, next.end);
      } else {
        merged.push(current);
        current = next;
      }
    }

    merged.push(current);
    return merged;
  }

  /**
   * Get app usage statistics for a user within a time range
   * Groups events by application name (desktop) or URL domain (web)
   * Only includes events with status='active' for productive time calculation
   *
   * @param tenantId - Tenant ID
   * @param userId - User ID
   * @param startTime - Start of time range (UTC)
   * @param endTime - End of time range (UTC)
   * @returns Array of app usage data grouped by app
   */
  async getAppUsageStats(
    tenantId: number,
    userId: number,
    startTime: Date,
    endTime: Date,
  ): Promise<RawAppUsage[]> {
    const queryStart = Date.now();

    try {
      // Get all active events in the time range
      const events = await this.rawEventRepository.find({
        where: {
          tenantId,
          userId,
          time: Between(startTime, endTime),
          status: 'active', // Only count active time for app usage
        },
        select: ['application', 'url', 'title', 'durationMs', 'activeDurationMs'],
      });

      this.logger.log(
        `Found ${events.length} active events for app usage in range ${startTime.toISOString()} to ${endTime.toISOString()}`,
      );

      // Helper function to safely convert numeric DB values (bigint / number / string) to number
      const toNumber = (
        value: bigint | number | string | null | undefined,
      ): number => {
        if (value === null || value === undefined) return 0;
        if (typeof value === 'number') return value;
        if (typeof value === 'bigint') return Number(value);
        if (typeof value === 'string') {
          const parsed = parseInt(value, 10);
          return isNaN(parsed) ? 0 : parsed;
        }
        return 0;
      };

      // Helper function to create display name from title or URL
      const createDisplayName = (
        title: string | null | undefined,
        url: string | null | undefined,
      ): string => {
        if (title && title.trim() !== '') {
          // Truncate long titles
          const trimmed = title.trim();
          return trimmed.length > 50 ? trimmed.substring(0, 47) + '...' : trimmed;
        }
        if (url && url.trim() !== '') {
          const domain = this.extractDomainFromUrlString(url);
          if (domain) {
            return domain;
          }
          // Fallback to truncated URL
          const trimmed = url.trim();
          return trimmed.length > 50 ? trimmed.substring(0, 47) + '...' : trimmed;
        }
        return 'Unknown';
      };

      // Group events by app name or domain, with nested breakdown by title/URL
      const appUsageMap = new Map<
        string,
        {
          appName: string;
          appType: 'desktop' | 'web';
          productiveTimeMs: number;
          urlBreakdownMap: Map<string, UrlBreakdown>; // Key: title+url combination
        }
      >();

      for (const event of events) {
        // Prefer active duration when available; fall back to durationMs for legacy events.
        const activeDuration = event.activeDurationMs ?? event.durationMs;
        const durationMs = toNumber(activeDuration);
        if (durationMs <= 0) continue;

        const resolved = this.resolveActivityIdentityForCategorization(event);
        if (!resolved) continue;
        const { appName, appType } = resolved;

        // Normalize app name (lowercase for grouping)
        const normalizedName = appName.toLowerCase();

        // Get or create app entry
        let appEntry = appUsageMap.get(normalizedName);
        if (!appEntry) {
          appEntry = {
            appName, // Use original name (not normalized) for display
            appType,
            productiveTimeMs: 0,
            urlBreakdownMap: new Map<string, UrlBreakdown>(),
          };
          appUsageMap.set(normalizedName, appEntry);
        }

        // Add to total time
        appEntry.productiveTimeMs += durationMs;

        // Create breakdown key from title and URL combination
        const title = event.title?.trim() || null;
        const url = event.url?.trim() || null;
        const breakdownKey = `${title || ''}|${url || ''}`;

        // Add to breakdown
        if (appEntry.urlBreakdownMap.has(breakdownKey)) {
          const existing = appEntry.urlBreakdownMap.get(breakdownKey)!;
          existing.productiveTimeMs += durationMs;
        } else {
          appEntry.urlBreakdownMap.set(breakdownKey, {
            title,
            url,
            displayName: createDisplayName(title, url),
            productiveTimeMs: durationMs,
          });
        }
      }

      // Convert to RawAppUsage format with sorted breakdown.
      // Do not slice here: StatsService categorizes URL breakdown entries and
      // uses them for totals. Trimming before categorization makes week/month
      // dashboard totals lower than the sum of daily totals.
      const appUsage: RawAppUsage[] = Array.from(appUsageMap.values()).map(
        (entry) => {
          // Sort breakdown by time descending. Response-size limiting happens
          // after category totals are calculated.
          const sortedBreakdown = Array.from(entry.urlBreakdownMap.values())
            .sort((a, b) => b.productiveTimeMs - a.productiveTimeMs);

          return {
            appName: entry.appName,
            appType: entry.appType,
            productiveTimeMs: entry.productiveTimeMs,
            urlBreakdown: sortedBreakdown,
          };
        },
      );

      // Sort apps by total time descending
      appUsage.sort((a, b) => b.productiveTimeMs - a.productiveTimeMs);

      const queryDuration = Date.now() - queryStart;
      this.logger.log(
        `✅ App usage query completed in ${queryDuration}ms: ${appUsage.length} unique apps`,
      );

      return appUsage;
    } catch (error) {
      const queryDuration = Date.now() - queryStart;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `❌ App usage query failed after ${queryDuration}ms for tenant ${tenantId}, user ${userId}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Get per-slot (5-minute) timeline statistics for a user within a time range.
   * For now this uses presence only: productivePct reflects the fraction of tracked
   * time in the slot that was active vs (active + idle/away). Neutral and
   * unproductive are left at 0; rule-based categories can be added later.
   */
  async getTimelineSlots(
    tenantId: number,
    userId: number,
    startTime: Date,
    endTime: Date,
    timeZone?: string,
  ): Promise<TimelineSlotDto[]> {
    const queryStart = Date.now();
    const SLOT_MINUTES = 5;
    const slotMs = SLOT_MINUTES * 60 * 1000;
    const rangeStartMs = startTime.getTime();
    const rangeEndMs = endTime.getTime();

    try {
      const events = await this.rawEventRepository.find({
        where: {
          tenantId,
          userId,
          time: Between(startTime, endTime),
        },
        order: { time: 'ASC' },
      });

      this.logger.log(
        `Found ${events.length} events for timeline in range ${startTime.toISOString()} to ${endTime.toISOString()}`,
      );

      const toNumber = (value: bigint | number | string | null | undefined): number => {
        if (value === null || value === undefined) return 0;
        if (typeof value === 'number') return value;
        if (typeof value === 'bigint') return Number(value);
        if (typeof value === 'string') {
          const parsed = parseInt(value, 10);
          return isNaN(parsed) ? 0 : parsed;
        }
        return 0;
      };

      type SlotAccum = {
        productiveMs: number;
        neutralMs: number;
        unproductiveMs: number;
        idleMs: number;
      };
      const slotMap = new Map<number, SlotAccum>();

      type SlotActivityCategory = 'productive' | 'neutral' | 'unproductive';
      type SlotActivityRow = {
        label: string;
        durationMs: number;
        category: SlotActivityCategory;
      };
      const slotActivitiesMap = new Map<number, Map<string, SlotActivityRow>>();
      const slotActiveParts = new Map<number, MsInterval[]>();
      const slotIdleParts = new Map<number, MsInterval[]>();

      for (const e of events) {
        const durationMs = toNumber(e.durationMs);
        if (durationMs <= 0) continue;

        const activeDurationMs = toNumber(e.activeDurationMs);
        const idleDurationMs = toNumber(e.idleDurationMs);

        // Derive how much of this event's wall-clock duration is active vs idle.
        const totalLabeled = activeDurationMs + idleDurationMs;
        const activeRatio =
          durationMs > 0
            ? totalLabeled > 0
              ? Math.min(1, activeDurationMs / durationMs)
              : 1 // legacy events: treat full duration as active
            : 0;
        const idleRatio =
          durationMs > 0
            ? totalLabeled > 0
              ? Math.min(1, idleDurationMs / durationMs)
              : 0
            : 0;

        // Derive event start/end in ms, falling back to recorded time + duration.
        const eventStartMs =
          e.startTime !== null && e.startTime !== undefined
            ? toNumber(e.startTime)
            : e.time.getTime();
        const rawEndMs =
          e.endTime !== null && e.endTime !== undefined
            ? toNumber(e.endTime)
            : eventStartMs + durationMs;

        // Clip to requested range
        const clippedStart = Math.max(eventStartMs, rangeStartMs);
        const clippedEnd = Math.min(rawEndMs, rangeEndMs);
        if (clippedEnd <= clippedStart) continue;

        // This event segment may span multiple 5‑minute slots; walk slot-by-slot.
        let segmentStart = clippedStart;
        while (segmentStart < clippedEnd) {
          const slotIndex = Math.floor((segmentStart - rangeStartMs) / slotMs);
          if (slotIndex < 0) break;

          const slotStart = rangeStartMs + slotIndex * slotMs;
          const slotEnd = slotStart + slotMs;
          const segmentEnd = Math.min(clippedEnd, slotEnd);
          const overlapMs = segmentEnd - segmentStart;

          const accum =
            slotMap.get(slotIndex) ?? {
              productiveMs: 0,
              neutralMs: 0,
              unproductiveMs: 0,
              idleMs: 0,
            };

          const activePortionMs = overlapMs * activeRatio;
          const idlePortionMs = overlapMs * idleRatio;

          if (e.status === 'active' && activePortionMs > 0) {
            const identity =
              this.resolveActivityIdentityForCategorization(e) ?? {
                appName:
                  e.application?.trim() ||
                  (e.source === 'browser' ? 'browser' : 'unknown'),
                appType: e.source === 'browser' ? 'web' : 'desktop',
              };

            const category = await this.appCategorizationService.categorizeApp(
              tenantId,
              userId,
              identity.appName,
              identity.appType,
              e.url ?? undefined,
            );

            const catEnum: SlotActivityCategory =
              category === 'productive'
                ? 'productive'
                : category === 'unproductive'
                  ? 'unproductive'
                  : 'neutral';

            switch (catEnum) {
              case 'productive':
                accum.productiveMs += activePortionMs;
                break;
              case 'unproductive':
                accum.unproductiveMs += activePortionMs;
                break;
              case 'neutral':
              default:
                accum.neutralMs += activePortionMs;
                break;
            }

            const label = timelineActivityDisplayLabel(e);
            const mergeKey = `${label.toLowerCase()}|${catEnum}`;
            let actSub = slotActivitiesMap.get(slotIndex);
            if (!actSub) {
              actSub = new Map<string, SlotActivityRow>();
              slotActivitiesMap.set(slotIndex, actSub);
            }
            const prevAct = actSub.get(mergeKey);
            if (prevAct) {
              prevAct.durationMs += activePortionMs;
            } else {
              actSub.set(mergeKey, {
                label,
                durationMs: activePortionMs,
                category: catEnum,
              });
            }
          }

          if (
            (e.status === 'active' || e.status === 'idle' || e.status === 'away') &&
            idlePortionMs > 0
          ) {
            accum.idleMs += idlePortionMs;
          }

          /**
           * Wall-clock split within this overlap (active first, then idle), aligned with bar semantics.
           * activeWall only when status is active; idleWall when active/idle/away and idle portion exists.
           */
          const activeWall = e.status === 'active' ? activePortionMs : 0;
          const idleWall =
            (e.status === 'active' || e.status === 'idle' || e.status === 'away') &&
            idlePortionMs > 0
              ? idlePortionMs
              : 0;
          const t0 = segmentStart;
          const t1 = t0 + activeWall;
          const t2 = t1 + idleWall;

          if (activeWall > 1 && e.status === 'active') {
            appendSlotInterval(slotActiveParts, slotIndex, t0, t1);
          }
          if (idleWall > 1) {
            appendSlotInterval(slotIdleParts, slotIndex, t1, t2);
          }

          slotMap.set(slotIndex, accum);
          segmentStart = segmentEnd;
        }
      }

      const totalSlots = Math.ceil((rangeEndMs - rangeStartMs) / slotMs);
      const slots: TimelineSlotDto[] = [];

      for (let i = 0; i < totalSlots; i++) {
        const accum =
          slotMap.get(i) ?? {
            productiveMs: 0,
            neutralMs: 0,
            unproductiveMs: 0,
            idleMs: 0,
          };

        const activeTotal =
          accum.productiveMs + accum.neutralMs + accum.unproductiveMs;
        const totalTracked = activeTotal + accum.idleMs;

        // Express bars as fraction of the 5‑minute slot, so
        // summed "area" over the day reflects real minutes.
        let productivePct = accum.productiveMs / slotMs;
        let neutralPct = accum.neutralMs / slotMs;
        let unproductivePct = accum.unproductiveMs / slotMs;

        // Guard against slight FP / overlap inflation.
        const sum = productivePct + neutralPct + unproductivePct;
        if (sum > 1) {
          productivePct /= sum;
          neutralPct /= sum;
          unproductivePct /= sum;
        }

        const slotStartMs = rangeStartMs + i * slotMs;
        const startMinuteFromMidnight = minutesFromMidnightInTimezone(
          new Date(slotStartMs),
          timeZone,
        );

        const mergedActive = mergeMsIntervals(slotActiveParts.get(i) ?? []);
        const rawMergedIdle = mergeMsIntervals(slotIdleParts.get(i) ?? []);
        /**
         * Subtract the active wall clock from the idle wall clock. When an admin
         * approves an offline-time request we insert a synthetic active event
         * (`__offline_approval__:*`) sharing its wall-clock with the original
         * idle event. Without this subtraction both would contribute to the
         * slot (active for the new approval, idle for the old event) and the
         * frontend's `getSlotFractions` would normalize the over-count into a
         * phantom idle stripe on the bar even though the slot is fully covered.
         */
        const mergedIdle = subtractMsIntervals(rawMergedIdle, mergedActive);
        const netIdleMs = mergedIdle.reduce(
          (acc, iv) => acc + (iv.endMs - iv.startMs),
          0,
        );

        const idleMs = netIdleMs;
        const idlePct = Math.min(1, slotMs > 0 ? idleMs / slotMs : 0);

        const actMap = slotActivitiesMap.get(i);
        const activities =
          actMap && actMap.size > 0
            ? Array.from(actMap.values())
                .sort((a, b) => b.durationMs - a.durationMs)
                .slice(0, 25)
            : undefined;

        const slotEndMs = slotStartMs + slotMs;
        const remainderIntervalsUtc =
          totalTracked > 0
            ? msIntervalsToIso(
                complementInRange(slotStartMs, slotEndMs, [
                  ...mergedActive,
                  ...mergedIdle,
                ]),
              )
            : [];

        const activeIntervalsUtc = msIntervalsToIso(mergedActive);
        const idleIntervalsUtc = msIntervalsToIso(mergedIdle);

        slots.push({
          startMinuteFromMidnight,
          slotStartUtc: new Date(slotStartMs).toISOString(),
          productivePct,
          neutralPct,
          unproductivePct,
          idlePct,
          idleMs,
          online: totalTracked > 0,
          ...(activities && activities.length > 0 ? { activities } : {}),
          activeIntervalsUtc,
          idleIntervalsUtc,
          remainderIntervalsUtc,
        });
      }

      const queryDuration = Date.now() - queryStart;
      this.logger.log(
        `✅ Timeline query completed in ${queryDuration}ms: ${slots.length} slots`,
      );

      return slots;
    } catch (error) {
      const queryDuration = Date.now() - queryStart;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `❌ Timeline query failed after ${queryDuration}ms for tenant ${tenantId}, user ${userId}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Same browser detection as app usage grouping (application name heuristic).
   */
  private isBrowserApplication(application: string | null | undefined): boolean {
    if (!application) return false;
    const appLower = application.toLowerCase();
    const browsers = [
      'chrome',
      'google chrome',
      'chromium',
      'firefox',
      'mozilla firefox',
      'edge',
      'microsoft edge',
      'safari',
      'opera',
      'brave',
      'vivaldi',
      'tor browser',
    ];
    return browsers.some((browser) => appLower.includes(browser));
  }

  private extractDomainFromUrlString(url: string | null | undefined): string | null {
    if (!url || url.trim() === '') return null;
    try {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        const urlObj = new URL(url);
        return urlObj.hostname.replace('www.', '');
      }
      if (url.includes('/')) {
        return url.split('/')[0].replace('www.', '');
      }
      return url.replace('www.', '');
    } catch {
      return null;
    }
  }

  /**
   * Infer a site/domain from a window title when URL is missing (browser sessions).
   * Kept in sync with app usage grouping logic.
   */
  private extractDomainFromWindowTitle(title: string | null | undefined): string | null {
    if (!title || title.trim() === '') return null;

    const titleLower = title.toLowerCase();

    const browserNames = [
      'google chrome',
      'chrome',
      'chromium',
      'mozilla firefox',
      'firefox',
      'microsoft edge',
      'edge',
      'safari',
      'opera',
      'brave',
      'vivaldi',
      'tor browser',
      'google search',
      'search',
    ];

    const domainRegex =
      /([a-zA-Z0-9.-]+\.(com|org|net|io|co|edu|gov|uk|de|fr|jp|au|ca|in|br|ru|cn|es|it|nl|se|no|dk|fi|pl|cz|at|ch|be|ie|pt|gr|tr|za|mx|ar|cl|pe|ve|ec|uy|py|bo|cr|pa|do|gt|hn|ni|sv|bz|jm|tt|bb|gd|lc|vc|ag|dm|kn|ai|vg|ky|ms|tc|fk|gi|mt|cy|is|li|mc|ad|sm|va|lu|mo|hk|sg|my|th|ph|id|vn|kh|la|mm|bn|pk|bd|lk|np|af|ir|iq|sa|ae|kw|bh|qa|om|ye|jo|lb|sy|il|ps|eg|ly|tn|dz|ma|mr|sn|ml|bf|ne|td|sd|er|et|dj|so|ke|ug|rw|bi|tz|zm|mw|mz|ao|na|bw|sz|ls|mg|mu|sc|km|yt|re|io|sh|ac|gs|tf|aq|bv|hm|sj|um|as|gu|mp|pr|vi|fm|mh|pw|ck|nu|pn|tk|to|tv|vu|ws|nf|nr|ki|sb|pg|fj|nc|pf|wf|eh|ax|gg|je|im|fo|gl|pm|bl|mf|so|dev))/i;
    const match = titleLower.match(domainRegex);
    if (match && match[1]) {
      return match[1].replace('www.', '');
    }

    const domainMap: Record<string, string> = {
      youtube: 'youtube.com',
      github: 'github.com',
      'stack overflow': 'stackoverflow.com',
      facebook: 'facebook.com',
      twitter: 'twitter.com',
      'x.com': 'x.com',
      linkedin: 'linkedin.com',
      reddit: 'reddit.com',
      instagram: 'instagram.com',
      discord: 'discord.com',
      slack: 'slack.com',
      gmail: 'gmail.com',
      outlook: 'outlook.com',
      notion: 'notion.so',
      figma: 'figma.com',
      trello: 'trello.com',
      asana: 'asana.com',
      jira: 'jira.com',
      confluence: 'confluence.com',
      medium: 'medium.com',
      dev: 'dev.to',
      'stack exchange': 'stackexchange.com',
      wikipedia: 'wikipedia.org',
      amazon: 'amazon.com',
      netflix: 'netflix.com',
      spotify: 'spotify.com',
      zoom: 'zoom.us',
      'microsoft teams': 'teams.microsoft.com',
      'google meet': 'meet.google.com',
    };

    const isBrowserOrSearchTerm = (text: string): boolean => {
      return browserNames.some((browser) => text.includes(browser));
    };

    const matchGoogleSite = (text: string): string | null => {
      const textLower = text.toLowerCase();
      if (
        textLower.includes('google chrome') ||
        textLower.includes('google search') ||
        textLower.includes('chromium')
      ) {
        return null;
      }
      if (/\bgoogle\b/.test(textLower)) {
        return 'google.com';
      }
      return null;
    };

    const parts = titleLower.split(' - ');

    if (parts.length > 0 && parts[0] !== '') {
      let firstPart = parts[0].trim();
      firstPart = firstPart.replace(/^[\(\d\)\s]+/, '').trim();

      const googleDomain = matchGoogleSite(firstPart);
      if (googleDomain) {
        return googleDomain;
      }

      for (const [key, domain] of Object.entries(domainMap)) {
        if (firstPart.includes(key)) {
          return domain;
        }
      }
    }

    if (parts.length > 1 && parts[1] !== '') {
      const secondPart = parts[1].trim();
      if (!isBrowserOrSearchTerm(secondPart)) {
        const googleDomain = matchGoogleSite(secondPart);
        if (googleDomain) {
          return googleDomain;
        }

        for (const [key, domain] of Object.entries(domainMap)) {
          if (secondPart.includes(key)) {
            return domain;
          }
        }
      }
    }

    let cleanedTitle = titleLower;
    for (const browser of browserNames) {
      cleanedTitle = cleanedTitle.replaceAll(browser, '');
    }

    const googleDomain = matchGoogleSite(cleanedTitle);
    if (googleDomain) {
      return googleDomain;
    }

    for (const [key, domain] of Object.entries(domainMap)) {
      if (cleanedTitle.includes(key)) {
        return domain;
      }
    }

    return null;
  }

  /**
   * Resolve the app name and type passed into productivity rules so timeline and
   * app usage use the same identity (domain from URL, then title heuristics, etc.).
   */
  private resolveActivityIdentityForCategorization(
    event: Pick<RawEventEntity, 'application' | 'url' | 'title'>,
  ): { appName: string; appType: 'desktop' | 'web' } | null {
    let appName: string | null = null;
    let appType: 'desktop' | 'web' = 'desktop';

    const applicationIsBrowser = this.isBrowserApplication(event.application);

    if (applicationIsBrowser) {
      let domain: string | null = null;

      if (event.url && event.url.trim() !== '') {
        domain = this.extractDomainFromUrlString(event.url);
      }

      if (!domain && event.title && event.title.trim() !== '') {
        domain = this.extractDomainFromWindowTitle(event.title);
      }

      if (domain) {
        appName = domain;
        appType = 'web';
      } else {
        appName = event.application?.trim() || null;
        appType = 'web';
      }
    } else if (event.application && event.application.trim() !== '') {
      appName = event.application.trim();
      appType = 'desktop';
    } else if (event.url && event.url.trim() !== '') {
      const domain = this.extractDomainFromUrlString(event.url);
      if (domain) {
        appName = domain;
        appType = 'web';
      }
    }

    if (!appName) return null;
    return { appName, appType };
  }

  /**
   * Return empty stats structure
   */
  private getEmptyStats(): DashboardStats {
    return {
      arrivalTime: null,
      leftTime: null,
      isOnline: false,
      productiveTimeMs: 0,
      deskTimeMs: 0,
      timeAtWorkMs: 0,
      productivityScorePct: 0,
      effectivenessPct: 0,
      projectsTimeMs: 0,
    };
  }
}
