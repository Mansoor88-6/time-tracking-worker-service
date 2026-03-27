import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { RawEventEntity } from '../timescale/entities/raw-event.entity';
import type { DashboardStats } from './interfaces/dashboard-stats.interface';
import type { RawAppUsage, UrlBreakdown } from './interfaces/app-usage.interface';
import { AppCategorizationService } from './app-categorization.service';

export interface TimelineSlotDto {
  startMinuteFromMidnight: number;
  productivePct: number;
  neutralPct: number;
  unproductivePct: number;
  online: boolean;
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

      // Helper function to safely convert numeric DB values (bigint / number / string) to number
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

      // Helper to get active duration with backward compatibility:
      // prefer activeDurationMs, fall back to durationMs for legacy events.
      const getActiveDuration = (e: RawEventEntity): number => {
        if (e.activeDurationMs !== null && e.activeDurationMs !== undefined) {
          return toNumber(e.activeDurationMs);
        }
        return toNumber(e.durationMs);
      };

      // Aggregate productive time from active duration (status='active')
      const productiveTimeMs = events
        .filter((e) => e.status === 'active')
        .reduce((sum, e) => sum + getActiveDuration(e), 0);

      // Aggregate desk time (status IN ('active','idle','away')) based on total tracked duration
      const deskTimeMs = events
        .filter(
          (e) =>
            (e.status === 'active' ||
              e.status === 'idle' ||
              e.status === 'away'),
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

      // Calculate projects time (status='active' AND project_id IS NOT NULL) from active duration
      const projectsTimeMs = events
        .filter(
          (e) =>
            e.status === 'active' &&
            e.projectId !== null &&
            e.projectId !== undefined &&
            (e.activeDurationMs !== null &&
              e.activeDurationMs !== undefined
              ? true
              : !!e.durationMs),
        )
        .reduce((sum, e) => sum + getActiveDuration(e), 0);

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

      // Helper function to check if application is a browser
      const isBrowser = (
        application: string | null | undefined,
      ): boolean => {
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

      // Helper function to extract domain from title (fallback for browser windows)
      const extractDomainFromTitle = (
        title: string | null | undefined,
      ): string | null => {
        if (!title || title.trim() === '') return null;

        const titleLower = title.toLowerCase();

        // Browser names and search terms to exclude from matching
        // (to avoid matching "google" in "Google Chrome" or "Google Search")
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
          'search', // Exclude search terms
        ];

        // Try to find domain pattern in title
        const domainRegex =
          /([a-zA-Z0-9.-]+\.(com|org|net|io|co|edu|gov|uk|de|fr|jp|au|ca|in|br|ru|cn|es|it|nl|se|no|dk|fi|pl|cz|at|ch|be|ie|pt|gr|tr|za|mx|ar|cl|pe|ve|ec|uy|py|bo|cr|pa|do|gt|hn|ni|sv|bz|jm|tt|bb|gd|lc|vc|ag|dm|kn|ai|vg|ky|ms|tc|fk|gi|mt|cy|is|li|mc|ad|sm|va|lu|mo|hk|sg|my|th|ph|id|vn|kh|la|mm|bn|pk|bd|lk|np|af|ir|iq|sa|ae|kw|bh|qa|om|ye|jo|lb|sy|il|ps|eg|ly|tn|dz|ma|mr|sn|ml|bf|ne|td|sd|er|et|dj|so|ke|ug|rw|bi|tz|zm|mw|mz|ao|na|bw|sz|ls|mg|mu|sc|km|yt|re|io|sh|ac|gs|tf|aq|bv|hm|sj|um|as|gu|mp|pr|vi|fm|mh|pw|ck|nu|pn|tk|to|tv|vu|ws|nf|nr|ki|sb|pg|fj|nc|pf|wf|eh|ax|gg|je|im|fo|gl|pm|bl|mf|so|dev))/i;
        const match = titleLower.match(domainRegex);
        if (match && match[1]) {
          return match[1].replace('www.', '');
        }

        // Pattern matching for common sites
        // Note: "google" is intentionally excluded from general matching
        // to avoid false matches in "Google Chrome" or "Google Search"
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

        // Helper to check if a string contains a browser name or search term
        const isBrowserOrSearchTerm = (text: string): boolean => {
          return browserNames.some((browser) => text.includes(browser));
        };

        // Helper to safely match "google" only when it's clearly a site (not browser/search)
        // Only match "google" if it appears alone or with site indicators
        const matchGoogleSite = (text: string): string | null => {
          const textLower = text.toLowerCase();
          // Only match "google" if it's not part of "google chrome", "google search", etc.
          if (
            textLower.includes('google chrome') ||
            textLower.includes('google search') ||
            textLower.includes('chromium')
          ) {
            return null;
          }
          // Match "google" only if it appears as a standalone word or with site context
          if (/\bgoogle\b/.test(textLower)) {
            return 'google.com';
          }
          return null;
        };

        // Split title by " - " to handle patterns like "Site - Browser" or "Site - Description"
        const parts = titleLower.split(' - ');

        // Priority 1: Check first part (site name) if it exists
        if (parts.length > 0 && parts[0] !== '') {
          let firstPart = parts[0].trim();
          // Remove leading numbers/parentheses like "(2) YouTube" → "youtube"
          firstPart = firstPart.replace(/^[\(\d\)\s]+/, '').trim();

          // Check for "google" site (with special handling)
          const googleDomain = matchGoogleSite(firstPart);
          if (googleDomain) {
            return googleDomain;
          }

          // Check known sites
          for (const [key, domain] of Object.entries(domainMap)) {
            if (firstPart.includes(key)) {
              return domain;
            }
          }
        }

        // Priority 2: Check second part only if it's NOT a browser/search term
        // This handles cases like "Google - YouTube" where second part is the destination
        if (parts.length > 1 && parts[1] !== '') {
          const secondPart = parts[1].trim();
          // Skip if this part contains a browser name or search term
          if (!isBrowserOrSearchTerm(secondPart)) {
            // Check for "google" site (with special handling)
            const googleDomain = matchGoogleSite(secondPart);
            if (googleDomain) {
              return googleDomain;
            }

            // Check known sites
            for (const [key, domain] of Object.entries(domainMap)) {
              if (secondPart.includes(key)) {
                return domain;
              }
            }
          }
        }

        // Priority 3: Check entire title, but exclude browser names and search terms
        // Create a cleaned version without browser names for matching
        let cleanedTitle = titleLower;
        for (const browser of browserNames) {
          cleanedTitle = cleanedTitle.replaceAll(browser, '');
        }

        // Check for "google" site in cleaned title (with special handling)
        const googleDomain = matchGoogleSite(cleanedTitle);
        if (googleDomain) {
          return googleDomain;
        }

        // Check known sites in cleaned title
        for (const [key, domain] of Object.entries(domainMap)) {
          // Only match if the key appears in the cleaned title
          if (cleanedTitle.includes(key)) {
            return domain;
          }
        }

        // If no match found, return null (don't guess)
        // This is better than returning a wrong domain
        return null;
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
        // Prefer active duration when available; fall back to durationMs for legacy events.
        const activeDuration = event.activeDurationMs ?? event.durationMs;
        const durationMs = toNumber(activeDuration);
        if (durationMs <= 0) continue;

        let appName: string | null = null;
        let appType: 'desktop' | 'web' = 'desktop';

        // Check if application is a browser
        const applicationIsBrowser = isBrowser(event.application);

        if (applicationIsBrowser) {
          // For browsers, prioritize domain extraction from URL or title
          let domain: string | null = null;

          // First, try to extract from URL field (populated by agent)
          if (event.url && event.url.trim() !== '') {
            domain = extractDomain(event.url);
          }

          // If no domain from URL, try to extract from title
          if (!domain && event.title && event.title.trim() !== '') {
            domain = extractDomainFromTitle(event.title);
          }

          // Use domain as app name if found
          if (domain) {
            appName = domain;
            appType = 'web';
          } else {
            // Fallback to browser name if no domain can be extracted
            appName = event.application?.trim() || null;
            appType = 'web';
          }
        } else if (event.application && event.application.trim() !== '') {
          // For non-browser apps, use application name
          appName = event.application.trim();
          appType = 'desktop';
        } else if (event.url && event.url.trim() !== '') {
          // Fallback: if no application but URL exists, extract domain
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
            const appType: 'desktop' | 'web' =
              e.source === 'browser' ? 'web' : 'desktop';
            const appName =
              e.application?.trim() ||
              (appType === 'web' ? 'browser' : 'unknown');

            const category = await this.appCategorizationService.categorizeApp(
              tenantId,
              userId,
              appName,
              appType,
              e.url ?? undefined,
            );

            switch (category) {
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
          }

          if (
            (e.status === 'active' || e.status === 'idle' || e.status === 'away') &&
            idlePortionMs > 0
          ) {
            accum.idleMs += idlePortionMs;
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

        slots.push({
          startMinuteFromMidnight,
          productivePct,
          neutralPct,
          unproductivePct,
          online: totalTracked > 0,
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
