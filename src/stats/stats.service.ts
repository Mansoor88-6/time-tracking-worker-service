import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StatsRepository, type DailyDashboardStatsRow } from './stats.repository';
import { RawEventsRepository } from '../timescale/raw-events.repository';
import {
  EventStatus,
  RawEvent,
} from '../events-consumer/interfaces/raw-event-message.interface';
import { AppCategorizationService } from './app-categorization.service';
import type { DashboardStats } from './interfaces/dashboard-stats.interface';
import type {
  AppUsage,
  AppUsageStats,
  AppCategory,
  UrlBreakdown,
} from './interfaces/app-usage.interface';

/**
 * Stats Service
 *
 * Handles business logic for dashboard statistics aggregation.
 * Includes timezone conversion and caching.
 */
@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);
  private readonly cache = new Map<
    string,
    { data: DashboardStats; expires: number }
  >();
  private readonly cacheTtlMs: number;

  // Separate cache for app usage stats
  private readonly appUsageCache = new Map<
    string,
    { data: AppUsageStats; expires: number }
  >();

  private readonly monthCalCache = new Map<
    string,
    { data: { days: DailyDashboardStatsRow[] }; expires: number }
  >();

  private readonly presenceCache = new Map<
    string,
    { data: Record<string, string>; expires: number }
  >();

  constructor(
    private readonly statsRepository: StatsRepository,
    private readonly configService: ConfigService,
    private readonly appCategorizationService: AppCategorizationService,
    private readonly rawEventsRepository: RawEventsRepository,
  ) {
    // Cache TTL: 15-30 seconds (configurable via env)
    this.cacheTtlMs =
      parseInt(process.env.STATS_CACHE_TTL_MS || '20000', 10) || 20000;
  }

  /**
   * Get dashboard stats for a user for a specific date or date range in their timezone
   *
   * @param tenantId - Tenant ID
   * @param userId - User ID
   * @param date - Date string in YYYY-MM-DD format (for single date)
   * @param timezone - IANA timezone (e.g., 'Asia/Karachi'), defaults to UTC
   * @param startDate - Start date string in YYYY-MM-DD format (for date range)
   * @param endDate - End date string in YYYY-MM-DD format (for date range)
   * @returns Dashboard statistics
   */
  async getDashboardStats(
    tenantId: number,
    userId: number,
    date?: string,
    timezone?: string,
    startDate?: string,
    endDate?: string,
  ): Promise<DashboardStats> {
    // Determine if using date range or single date
    const useDateRange = startDate && endDate;
    
    let cacheKey: string;
    let startTime: Date;
    let endTime: Date;

    if (useDateRange) {
      // Use date range
      const boundaries = this.getDateRangeBoundaries(startDate, endDate, timezone);
      startTime = boundaries.startTime;
      endTime = boundaries.endTime;
      cacheKey = `${tenantId}:${userId}:${startDate}:${endDate}:${timezone || 'UTC'}`;
    } else {
      // Use single date (backward compatibility)
      if (!date) {
        throw new Error('Either date or startDate/endDate must be provided');
      }
      const boundaries = this.getDayBoundaries(date, timezone);
      startTime = boundaries.startTime;
      endTime = boundaries.endTime;
      cacheKey = `${tenantId}:${userId}:${date}:${timezone || 'UTC'}`;
    }

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      this.logger.log(
        `📦 Cache hit for ${cacheKey} (expires in ${Math.round((cached.expires - Date.now()) / 1000)}s)`,
      );
      return cached.data;
    }

    if (cached) {
      this.logger.debug(`Cache expired for ${cacheKey}, fetching fresh data`);
    }

    this.logger.log(
      `🔍 Querying events: UTC ${startTime.toISOString()} to ${endTime.toISOString()}`,
    );

    // Fetch stats from repository
    let stats = await this.statsRepository.getDashboardStats(
      tenantId,
      userId,
      startTime,
      endTime,
    );

    // Use rule-based totals from app usage so top cards always match app usage (single date or range)
    let appUsage: AppUsageStats | null = null;
    try {
      if (useDateRange && startDate && endDate) {
        appUsage = await this.getAppUsageStats(
          tenantId,
          userId,
          undefined,
          timezone,
          startDate,
          endDate,
        );
      } else if (date) {
        appUsage = await this.getAppUsageStats(
          tenantId,
          userId,
          date,
          timezone,
        );
      }
    } catch (err) {
      this.logger.warn(
        `App usage for rule-based stats failed, using repo stats: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (appUsage) {
      stats = {
        ...stats,
        productiveTimeMs: appUsage.totals.productive ?? 0,
        unproductiveTimeMs: appUsage.totals.unproductive ?? 0,
        neutralTimeMs: appUsage.totals.neutral ?? 0,
        productivityScorePct: Math.min(
          100,
          Math.max(
            0,
            stats.deskTimeMs > 0
              ? Math.round(
                  (appUsage.totals.productive / stats.deskTimeMs) * 100,
                )
              : 0,
          ),
        ),
        effectivenessPct: Math.min(
          100,
          Math.max(
            0,
            stats.timeAtWorkMs > 0
              ? Math.round(
                  (appUsage.totals.productive / stats.timeAtWorkMs) * 100,
                )
              : 0,
          ),
        ),
      };
    }

    this.logger.log(
      `📊 Stats calculated: arrivalTime=${stats.arrivalTime?.toISOString() || 'null'}, events=${stats.productiveTimeMs > 0 || stats.deskTimeMs > 0 ? 'found' : 'none'}`,
    );

    // Cache the result
    this.cache.set(cacheKey, {
      data: stats,
      expires: Date.now() + this.cacheTtlMs,
    });

    // Clean up expired cache entries periodically
    this.cleanupCache();

    return stats;
  }

  /**
   * Per-day dashboard stats for a month (or any inclusive YYYY-MM-DD range, max 62 days).
   * One Timescale query; buckets by local date in `timezone`.
   */
  async getMonthlyCalendarStats(
    tenantId: number,
    userId: number,
    startDate: string,
    endDate: string,
    timezone?: string,
  ): Promise<{ days: DailyDashboardStatsRow[] }> {
    const orderedDays = this.enumerateInclusiveDateStrings(startDate, endDate);
    if (orderedDays.length > 62) {
      throw new BadRequestException('Date range too large (max 62 days)');
    }

    const cacheKey = `${tenantId}:${userId}:${startDate}:${endDate}:${timezone || 'UTC'}:month-cal`;
    const cached = this.monthCalCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      this.logger.log(
        `📦 Month calendar cache hit (expires in ${Math.round((cached.expires - Date.now()) / 1000)}s)`,
      );
      return cached.data;
    }

    const { startTime, endTime } = this.getDateRangeBoundaries(
      startDate,
      endDate,
      timezone,
    );

    this.logger.log(
      `🗓️ Month calendar: ${orderedDays.length} day(s), UTC ${startTime.toISOString()} – ${endTime.toISOString()}`,
    );

    const days = await this.statsRepository.getDashboardStatsPerDay(
      tenantId,
      userId,
      startTime,
      endTime,
      orderedDays,
      timezone,
    );

    const payload = { days };
    this.monthCalCache.set(cacheKey, {
      data: payload,
      expires: Date.now() + this.cacheTtlMs,
    });
    this.cleanupMonthCalCache();

    return payload;
  }

  /**
   * Users with at least one raw event in [now - windowSec, now].
   * Cached briefly to protect Timescale when many dashboards poll.
   */
  async getColleaguesPresence(
    tenantId: number,
    windowSec: number = 120,
  ): Promise<{ presence: Record<string, string>; windowSec: number }> {
    const w = Math.min(600, Math.max(30, windowSec));
    const cacheKey = `${tenantId}:${w}:presence`;
    const hit = this.presenceCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      return { presence: hit.data, windowSec: w };
    }

    const since = new Date(Date.now() - w * 1000);
    const map = await this.statsRepository.getLastActivityPerUserInWindow(
      tenantId,
      since,
    );
    const presence: Record<string, string> = {};
    for (const [uid, t] of map) {
      presence[String(uid)] = t.toISOString();
    }

    this.presenceCache.set(cacheKey, {
      data: presence,
      expires: Date.now() + 12_000,
    });
    this.cleanupPresenceCache();

    return { presence, windowSec: w };
  }

  private enumerateInclusiveDateStrings(start: string, end: string): string[] {
    const [ys, ms, ds] = start.split('-').map(Number);
    const [ye, me, de] = end.split('-').map(Number);
    const pad = (n: number) => String(n).padStart(2, '0');
    const out: string[] = [];
    let y = ys;
    let m = ms;
    let d = ds;
    for (;;) {
      out.push(`${y}-${pad(m)}-${pad(d)}`);
      if (y === ye && m === me && d === de) break;
      const next = new Date(Date.UTC(y, m - 1, d + 1));
      y = next.getUTCFullYear();
      m = next.getUTCMonth() + 1;
      d = next.getUTCDate();
    }
    return out;
  }

  /**
   * Convert a date string and timezone to UTC day boundaries
   *
   * @param date - Date string in YYYY-MM-DD format
   * @param timezone - IANA timezone (e.g., 'Asia/Karachi')
   * @returns Start and end times in UTC
   */
  private getDayBoundaries(
    date: string,
    timezone?: string,
  ): { startTime: Date; endTime: Date } {
    // Parse date (YYYY-MM-DD)
    const [year, month, day] = date.split('-').map(Number);

    if (timezone) {
      try {
        // Simple and reliable approach:
        // Create a date at noon UTC, see what time it is in the timezone
        // Then calculate the offset to determine when midnight in timezone occurs in UTC
        const noonUtc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));

        // Get what time noon UTC is in the target timezone
        const tzFormatter = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });

        const tzNoonStr = tzFormatter.format(noonUtc);
        const [tzHour, tzMin] = tzNoonStr.split(':').map(Number);

        // Calculate offset: if noon UTC is 17:00 in timezone, offset is +5 hours
        // Offset in minutes = (tzHour * 60 + tzMin) - (12 * 60)
        const offsetMinutes = tzHour * 60 + tzMin - 12 * 60;
        const offsetMs = offsetMinutes * 60 * 1000;

        // Midnight in timezone = UTC midnight - offset
        // Example: If timezone is UTC+5, midnight in timezone = 19:00 previous day in UTC
        const midnightUtc = new Date(
          Date.UTC(year, month - 1, day, 0, 0, 0, 0),
        );
        const startTime = new Date(midnightUtc.getTime() - offsetMs);
        const endTime = new Date(startTime.getTime() + 24 * 60 * 60 * 1000);

        this.logger.debug(
          `Timezone conversion: ${date} in ${timezone} -> UTC ${startTime.toISOString()} to ${endTime.toISOString()}`,
        );

        return { startTime, endTime };
      } catch (error) {
        this.logger.warn(
          `Invalid timezone ${timezone}, falling back to UTC: ${error instanceof Error ? error.message : String(error)}`,
        );
        const startTime = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
        const endTime = new Date(
          Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0),
        );
        return { startTime, endTime };
      }
    } else {
      // UTC timezone
      const startTime = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
      const endTime = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0));
      return { startTime, endTime };
    }
  }

  /**
   * Convert a date range and timezone to UTC boundaries
   *
   * @param startDate - Start date string in YYYY-MM-DD format
   * @param endDate - End date string in YYYY-MM-DD format
   * @param timezone - IANA timezone (e.g., 'Asia/Karachi')
   * @returns Start and end times in UTC
   */
  private getDateRangeBoundaries(
    startDate: string,
    endDate: string,
    timezone?: string,
  ): { startTime: Date; endTime: Date } {
    // Get start of first day
    const startBoundaries = this.getDayBoundaries(startDate, timezone);
    const startTime = startBoundaries.startTime;

    // Get end of last day
    const endBoundaries = this.getDayBoundaries(endDate, timezone);
    const endTime = endBoundaries.endTime;

    this.logger.debug(
      `Date range conversion: ${startDate} to ${endDate} in ${timezone || 'UTC'} -> UTC ${startTime.toISOString()} to ${endTime.toISOString()}`,
    );

    return { startTime, endTime };
  }

  /**
   * Clear cache for a specific user/date combination
   * Useful when events are deleted and we want fresh stats
   */
  clearCache(tenantId: number, userId: number, date: string, timezone?: string): void {
    const cacheKey = `${tenantId}:${userId}:${date}:${timezone || 'UTC'}`;
    const deleted = this.cache.delete(cacheKey);
    if (deleted) {
      this.logger.debug(`Cache cleared for ${cacheKey}`);
    }
  }

  /**
   * Invalidate all dashboard stats, app usage, and month-calendar cache keys for a user
   * (any timezone / date-range variant) after raw events change.
   */
  private invalidateCachesForUser(tenantId: number, userId: number): void {
    const prefix = `${tenantId}:${userId}:`;
    let removed = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        removed++;
      }
    }
    for (const key of this.appUsageCache.keys()) {
      if (key.startsWith(prefix)) {
        this.appUsageCache.delete(key);
        removed++;
      }
    }
    for (const key of this.monthCalCache.keys()) {
      if (key.startsWith(prefix)) {
        this.monthCalCache.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      this.logger.debug(
        `Invalidated ${removed} stats cache entr${removed === 1 ? 'y' : 'ies'} for tenant=${tenantId} user=${userId}`,
      );
    }
  }

  /**
   * Insert a synthetic active event after admin approves an offline-time request (Option A).
   * Categorization uses application prefix __offline_approval__:* in AppCategorizationService.
   */
  async insertManualOfflineEvent(params: {
    tenantId: number;
    userId: number;
    requestId: number;
    startMs: number;
    endMs: number;
    category: 'productive' | 'neutral' | 'unproductive';
    description: string;
  }): Promise<void> {
    const {
      tenantId,
      userId,
      requestId,
      startMs,
      endMs,
      category,
      description,
    } = params;
    if (endMs <= startMs) {
      throw new BadRequestException('endMs must be greater than startMs');
    }
    const duration = endMs - startMs;
    const application = `__offline_approval__:${category}`;
    const event: RawEvent = {
      deviceId: `offline-request-${requestId}`,
      timestamp: startMs,
      status: EventStatus.ACTIVE,
      application,
      title: description.slice(0, 500),
      duration,
      startTime: startMs,
      endTime: endMs,
      activeDuration: duration,
      idleDuration: 0,
      source: 'app',
    };
    const saved = await this.rawEventsRepository.saveBatch(
      tenantId,
      userId,
      event.deviceId,
      [event],
    );
    if (saved === 0) {
      throw new BadRequestException(
        'Event was not inserted (duplicate or conflict)',
      );
    }
    this.invalidateCachesForUser(tenantId, userId);
    this.logger.log(
      `Manual offline event inserted for tenant=${tenantId} user=${userId} request=${requestId}`,
    );
  }

  async deleteTrackedTimeRange(params: {
    tenantId: number;
    userId: number;
    startMs: number;
    endMs: number;
  }): Promise<{
    deletedEvents: number;
    trimmedEvents: number;
    splitEvents: number;
  }> {
    const { tenantId, userId, startMs, endMs } = params;
    if (endMs <= startMs) {
      throw new BadRequestException('endMs must be greater than startMs');
    }

    const maxMs = 24 * 60 * 60 * 1000;
    if (endMs - startMs > maxMs) {
      throw new BadRequestException('Delete range cannot exceed 24 hours');
    }

    const result = await this.rawEventsRepository.deleteUserTimeRange({
      tenantId,
      userId,
      startMs,
      endMs,
    });

    this.invalidateCachesForUser(tenantId, userId);

    return result;
  }

  /**
   * Get app usage statistics for a user for a date or date range in their timezone
   *
   * @param tenantId - Tenant ID
   * @param userId - User ID
   * @param date - Date string in YYYY-MM-DD format (used when no range)
   * @param timezone - IANA timezone (e.g., 'Asia/Karachi'), defaults to UTC
   * @param startDate - Start date for range (optional)
   * @param endDate - End date for range (optional)
   * @returns App usage statistics grouped by category
   */
  async getAppUsageStats(
    tenantId: number,
    userId: number,
    date: string | undefined,
    timezone?: string,
    startDate?: string,
    endDate?: string,
  ): Promise<AppUsageStats> {
    const useRange = !!startDate && !!endDate;
    const singleDate = date || new Date().toISOString().slice(0, 10);
    const cacheKey = useRange
      ? `${tenantId}:${userId}:${startDate}:${endDate}:${timezone || 'UTC'}:app-usage`
      : `${tenantId}:${userId}:${singleDate}:${timezone || 'UTC'}:app-usage`;

    // Check cache
    const cached = this.appUsageCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      this.logger.log(
        `📦 App usage cache hit for ${cacheKey} (expires in ${Math.round((cached.expires - Date.now()) / 1000)}s)`,
      );
      return cached.data;
    }

    if (cached) {
      this.logger.debug(`App usage cache expired for ${cacheKey}, fetching fresh data`);
    }

    const { startTime, endTime } = useRange
      ? this.getDateRangeBoundaries(startDate!, endDate!, timezone)
      : this.getDayBoundaries(singleDate, timezone);

    this.logger.log(
      `🔍 Querying app usage: UTC ${startTime.toISOString()} to ${endTime.toISOString()}`,
    );

    // Fetch raw app usage data from repository
    const rawAppUsage = await this.statsRepository.getAppUsageStats(
      tenantId,
      userId,
      startTime,
      endTime,
    );

    // Categorize each app
    const categorized: AppUsageStats = {
      productive: [],
      unproductive: [],
      neutral: [],
      totals: {
        productive: 0,
        unproductive: 0,
        neutral: 0,
      },
    };

    // Limit response payloads for performance. Totals are calculated before
    // these display-only slices so long ranges stay numerically accurate.
    const maxAppsPerCategory = 20;
    const maxUrlBreakdownItemsPerApp = 15;

    type CategoryBucket = { productiveTimeMs: number; urlBreakdown: UrlBreakdown[] };

    const limitUrlBreakdownForDisplay = (
      breakdown: UrlBreakdown[] = [],
    ): UrlBreakdown[] =>
      [...breakdown]
        .sort((a, b) => b.productiveTimeMs - a.productiveTimeMs)
        .slice(0, maxUrlBreakdownItemsPerApp);

    for (const app of rawAppUsage) {
      if (app.appType === 'desktop') {
        // Desktop: one category per app (no URL)
        const category = await this.appCategorizationService.categorizeApp(
          tenantId,
          userId,
          app.appName,
          app.appType,
          undefined,
        );
        const appUsage: AppUsage = {
          ...app,
          category,
          urlBreakdown: limitUrlBreakdownForDisplay(app.urlBreakdown),
        };
        switch (category) {
          case 'productive':
            categorized.productive.push(appUsage);
            categorized.totals.productive += app.productiveTimeMs;
            break;
          case 'unproductive':
            categorized.unproductive.push(appUsage);
            categorized.totals.unproductive += app.productiveTimeMs;
            break;
          case 'neutral':
            categorized.neutral.push(appUsage);
            categorized.totals.neutral += app.productiveTimeMs;
            break;
        }
        continue;
      }

      // Web: categorize per URL, then emit one row per (domain, category)
      const buckets: Record<AppCategory, CategoryBucket> = {
        productive: { productiveTimeMs: 0, urlBreakdown: [] },
        unproductive: { productiveTimeMs: 0, urlBreakdown: [] },
        neutral: { productiveTimeMs: 0, urlBreakdown: [] },
      };

      if (app.urlBreakdown.length === 0) {
        // No breakdown: fall back to domain-only categorization
        const category = await this.appCategorizationService.categorizeApp(
          tenantId,
          userId,
          app.appName,
          app.appType,
          undefined,
        );
        buckets[category].productiveTimeMs = app.productiveTimeMs;
      } else {
        for (const entry of app.urlBreakdown) {
          const category = await this.appCategorizationService.categorizeApp(
            tenantId,
            userId,
            app.appName,
            app.appType,
            entry.url ?? undefined,
          );
          buckets[category].productiveTimeMs += entry.productiveTimeMs;
          buckets[category].urlBreakdown.push(entry);
        }
      }

      for (const category of ['productive', 'unproductive', 'neutral'] as const) {
        const bucket = buckets[category];
        if (bucket.productiveTimeMs <= 0) continue;
        categorized[category].push({
          appName: app.appName,
          appType: app.appType,
          productiveTimeMs: bucket.productiveTimeMs,
          category,
          urlBreakdown: limitUrlBreakdownForDisplay(bucket.urlBreakdown),
        });
        categorized.totals[category] += bucket.productiveTimeMs;
      }
    }

    // Sort each category by time descending and limit
    categorized.productive.sort((a, b) => b.productiveTimeMs - a.productiveTimeMs);
    categorized.unproductive.sort((a, b) => b.productiveTimeMs - a.productiveTimeMs);
    categorized.neutral.sort((a, b) => b.productiveTimeMs - a.productiveTimeMs);

    categorized.productive = categorized.productive.slice(0, maxAppsPerCategory);
    categorized.unproductive = categorized.unproductive.slice(0, maxAppsPerCategory);
    categorized.neutral = categorized.neutral.slice(0, maxAppsPerCategory);

    this.logger.log(
      `📊 App usage calculated: ${categorized.productive.length} productive, ${categorized.unproductive.length} unproductive, ${categorized.neutral.length} neutral`,
    );

    // Cache the result
    this.appUsageCache.set(cacheKey, {
      data: categorized,
      expires: Date.now() + this.cacheTtlMs,
    });

    // Clean up expired cache entries
    this.cleanupAppUsageCache();

    return categorized;
  }

  /**
   * Get timeline slots (5-minute buckets) for a user for a given date or date range
   * in their timezone. Uses the same boundary helpers as other stats methods.
   */
  async getTimelineSlots(
    tenantId: number,
    userId: number,
    date: string | undefined,
    timezone?: string,
    startDate?: string,
    endDate?: string,
  ) {
    const useRange = !!startDate && !!endDate;
    const singleDate = date || new Date().toISOString().slice(0, 10);

    const { startTime, endTime } = useRange
      ? this.getDateRangeBoundaries(startDate!, endDate!, timezone)
      : this.getDayBoundaries(singleDate, timezone);

    this.logger.log(
      `🔍 Querying timeline slots: UTC ${startTime.toISOString()} to ${endTime.toISOString()}`,
    );

    return this.statsRepository.getTimelineSlots(
      tenantId,
      userId,
      startTime,
      endTime,
      timezone,
    );
  }

  /**
   * Clear all cache entries (dashboard stats and app usage)
   */
  clearAllCache(): void {
    const size = this.cache.size;
    const appUsageSize = this.appUsageCache.size;
    this.cache.clear();
    this.appUsageCache.clear();
    this.logger.debug(
      `Cleared all cache entries (dashboard: ${size}, app usage: ${appUsageSize})`,
    );
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupCache(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of this.cache.entries()) {
      if (value.expires <= now) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} expired cache entries`);
    }
  }

  /**
   * Clean up expired app usage cache entries
   */
  private cleanupAppUsageCache(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of this.appUsageCache.entries()) {
      if (value.expires <= now) {
        this.appUsageCache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} expired app usage cache entries`);
    }
  }

  private cleanupMonthCalCache(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of this.monthCalCache.entries()) {
      if (value.expires <= now) {
        this.monthCalCache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} expired month calendar cache entries`);
    }
  }

  private cleanupPresenceCache(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of this.presenceCache.entries()) {
      if (value.expires <= now) {
        this.presenceCache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} expired presence cache entries`);
    }
  }
}
