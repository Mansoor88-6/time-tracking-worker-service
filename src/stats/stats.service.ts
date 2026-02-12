import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StatsRepository } from './stats.repository';
import { AppCategorizationService } from './app-categorization.service';
import type { DashboardStats } from './interfaces/dashboard-stats.interface';
import type { AppUsageStats } from './interfaces/app-usage.interface';

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

  constructor(
    private readonly statsRepository: StatsRepository,
    private readonly configService: ConfigService,
    private readonly appCategorizationService: AppCategorizationService,
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
    const stats = await this.statsRepository.getDashboardStats(
      tenantId,
      userId,
      startTime,
      endTime,
    );

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
   * Get app usage statistics for a user for a specific date in their timezone
   *
   * @param tenantId - Tenant ID
   * @param userId - User ID
   * @param date - Date string in YYYY-MM-DD format
   * @param timezone - IANA timezone (e.g., 'Asia/Karachi'), defaults to UTC
   * @returns App usage statistics grouped by category
   */
  async getAppUsageStats(
    tenantId: number,
    userId: number,
    date: string,
    timezone?: string,
  ): Promise<AppUsageStats> {
    const cacheKey = `${tenantId}:${userId}:${date}:${timezone || 'UTC'}:app-usage`;

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

    // Calculate timezone-aware day boundaries (same logic as dashboard stats)
    const { startTime, endTime } = this.getDayBoundaries(date, timezone);

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

    // Limit to top 20 apps per category for performance
    const maxAppsPerCategory = 20;

    for (const app of rawAppUsage) {
      // For web apps, extract URL from breakdown for URL-based rule matching
      // Use the most common URL (first in sorted breakdown)
      const url = app.appType === 'web' && app.urlBreakdown.length > 0
        ? app.urlBreakdown[0].url || null
        : undefined;

      const category = await this.appCategorizationService.categorizeApp(
        tenantId,
        userId,
        app.appName,
        app.appType,
        url || undefined,
      );

      const appUsage = {
        ...app,
        category,
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
   * Clear all cache entries
   */
  clearAllCache(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.logger.debug(`Cleared all cache entries (${size} entries)`);
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
}
