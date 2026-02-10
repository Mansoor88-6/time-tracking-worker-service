import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { RawEventEntity } from '../timescale/entities/raw-event.entity';
import type { DashboardStats } from './interfaces/dashboard-stats.interface';
import type { RawAppUsage, UrlBreakdown } from './interfaces/app-usage.interface';

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
  ) {}

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
      // Get all events in the time range
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
      }

      // If no events, return empty stats
      if (events.length === 0) {
        this.logger.log('No events found, returning empty stats');
        return this.getEmptyStats();
      }

      // Filter out offline events for arrival/left time calculation
      const nonOfflineEvents = events.filter((e) => e.status !== 'offline');

      // Calculate arrival time (first non-offline event)
      const arrivalTime =
        nonOfflineEvents.length > 0 ? nonOfflineEvents[0].time : null;

      // Calculate left time and online status
      const lastNonOfflineEvent =
        nonOfflineEvents.length > 0
          ? nonOfflineEvents[nonOfflineEvents.length - 1]
          : null;

      const now = new Date();
      const lastEventTime = lastNonOfflineEvent
        ? new Date(lastNonOfflineEvent.time)
        : null;

      // User is online if last non-offline event is within activity window
      const isOnline: boolean =
        !!(
          lastEventTime &&
          lastNonOfflineEvent &&
          lastNonOfflineEvent.status !== 'offline' &&
          now.getTime() - lastEventTime.getTime() < activityWindowSec * 1000
        );

      const leftTime = isOnline ? null : lastEventTime;

      // Helper function to safely convert durationMs to number
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

      // Aggregate productive time (status='active')
      const productiveTimeMs = events
        .filter((e) => e.status === 'active' && e.durationMs)
        .reduce((sum, e) => sum + toNumber(e.durationMs), 0);

      // Aggregate desk time (status IN ('active','idle','away'))
      const deskTimeMs = events
        .filter(
          (e) =>
            (e.status === 'active' ||
              e.status === 'idle' ||
              e.status === 'away') &&
            e.durationMs,
        )
        .reduce((sum, e) => sum + toNumber(e.durationMs), 0);

      // Calculate time at work (total time from arrival to departure/current time)
      // This should be the wall-clock time from when user arrived to when they left (or now if online)
      let timeAtWorkMs = 0;
      if (arrivalTime) {
        let endTime: Date;
        if (isOnline) {
          // If online, use current time
          endTime = now;
        } else if (leftTime && lastNonOfflineEvent) {
          // If offline, use the end time of the last event (time + duration)
          const lastEventEndTime =
            lastNonOfflineEvent.time.getTime() +
            toNumber(lastNonOfflineEvent.durationMs);
          endTime = new Date(lastEventEndTime);
        } else {
          // Fallback to current time
          endTime = now;
        }
        timeAtWorkMs = Math.max(0, endTime.getTime() - arrivalTime.getTime());
      }

      // Calculate projects time (status='active' AND project_id IS NOT NULL)
      const projectsTimeMs = events
        .filter(
          (e) =>
            e.status === 'active' &&
            e.projectId !== null &&
            e.projectId !== undefined &&
            e.durationMs,
        )
        .reduce((sum, e) => sum + toNumber(e.durationMs), 0);

      // Calculate percentages
      const productivityScorePct =
        deskTimeMs > 0 ? Math.round((productiveTimeMs / deskTimeMs) * 100) : 0;
      const effectivenessPct =
        timeAtWorkMs > 0
          ? Math.round((productiveTimeMs / timeAtWorkMs) * 100)
          : 0;

      const queryDuration = Date.now() - queryStart;
      this.logger.log(
        `✅ Stats query completed in ${queryDuration}ms for tenant ${tenantId}, user ${userId}`,
      );

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
        select: ['application', 'url', 'title', 'durationMs'],
      });

      this.logger.log(
        `Found ${events.length} active events for app usage in range ${startTime.toISOString()} to ${endTime.toISOString()}`,
      );

      // Helper function to safely convert durationMs to number
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

      // Helper function to extract domain from URL
      const extractDomain = (url: string | null | undefined): string | null => {
        if (!url || url.trim() === '') return null;
        try {
          // If it's a full URL, extract domain
          if (url.startsWith('http://') || url.startsWith('https://')) {
            const urlObj = new URL(url);
            return urlObj.hostname.replace('www.', '');
          }
          // If it's domain/path, extract just domain
          if (url.includes('/')) {
            return url.split('/')[0].replace('www.', '');
          }
          return url.replace('www.', '');
        } catch {
          // If URL parsing fails, return null
          return null;
        }
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
          const domain = extractDomain(url);
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
        const durationMs = toNumber(event.durationMs);
        if (durationMs <= 0) continue;

        let appName: string | null = null;
        let appType: 'desktop' | 'web' = 'desktop';

        // Prefer application field for desktop apps
        if (event.application && event.application.trim() !== '') {
          appName = event.application.trim();
          appType = 'desktop';
        } else if (event.url && event.url.trim() !== '') {
          // Use URL domain for web apps
          const domain = extractDomain(event.url);
          if (domain) {
            appName = domain;
            appType = 'web';
          }
        }

        // Skip if we couldn't identify the app
        if (!appName) continue;

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

      // Convert to RawAppUsage format with sorted breakdown
      const appUsage: RawAppUsage[] = Array.from(appUsageMap.values()).map(
        (entry) => {
          // Sort breakdown by time descending and limit to top 15
          const sortedBreakdown = Array.from(entry.urlBreakdownMap.values())
            .sort((a, b) => b.productiveTimeMs - a.productiveTimeMs)
            .slice(0, 15);

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
