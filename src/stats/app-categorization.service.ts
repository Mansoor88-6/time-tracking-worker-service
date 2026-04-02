import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull } from 'typeorm';
import type { AppCategory, AppType } from './interfaces/app-usage.interface';
import { TeamProductivityRule, AppType as RuleAppType, AppCategory as RuleAppCategory, RuleType } from '../backend-db/entities/team-productivity-rule.entity';
import { TeamMember } from '../backend-db/entities/team-member.entity';
import { RuleCollectionTeam } from '../backend-db/entities/rule-collection-team.entity';
import { UnclassifiedAppsTrackerService } from '../productivity-rules/unclassified-apps-tracker.service';
import { URLParserService } from './url-parser.service';

/**
 * App Categorization Service
 *
 * Categorizes applications as productive, unproductive, or neutral.
 * Uses team-based rules from database, with fallback to default rules.
 */
@Injectable()
export class AppCategorizationService {
  private readonly logger = new Logger(AppCategorizationService.name);

  // Cache for team rules (key: tenantId:userId, value: rules map)
  // Legacy cache: "appName:appType" -> category
  private readonly rulesCache = new Map<string, Map<string, RuleAppCategory>>();
  // New cache: stores full rule objects for URL/domain matching
  private readonly rulesCacheFull = new Map<string, TeamProductivityRule[]>();
  private readonly cacheExpiry = new Map<string, number>();
  private readonly CACHE_TTL_MS = 60000; // 1 minute cache

  // Browser names: when stats repo groups browser activity with no domain it uses appType 'web'
  // Team rules are often created as desktop (e.g. "Chrome" desktop = unproductive). We match those here.
  private readonly browserAppNames = new Set([
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
  ]);

  constructor(
    @InjectRepository(TeamProductivityRule, 'backend')
    private readonly rulesRepository: Repository<TeamProductivityRule>,
    @InjectRepository(TeamMember, 'backend')
    private readonly teamMembersRepository: Repository<TeamMember>,
    @InjectRepository(RuleCollectionTeam, 'backend')
    private readonly collectionTeamsRepository: Repository<RuleCollectionTeam>,
    private readonly unclassifiedTracker: UnclassifiedAppsTrackerService,
    private readonly urlParser: URLParserService,
  ) {}

  /**
   * Categorize an application based on team rules
   *
   * @param tenantId - Tenant ID
   * @param userId - User ID
   * @param appName - Application name (desktop app) or domain (web app)
   * @param appType - Type of application (desktop or web)
   * @param url - Optional URL for URL-based rule matching
   * @returns Category: productive, unproductive, or neutral
   */
  async categorizeApp(
    tenantId: number,
    userId: number,
    appName: string,
    appType: AppType,
    url?: string,
  ): Promise<AppCategory> {
    if (!appName || appName.trim() === '') {
      return 'neutral';
    }
    const normalizedName = appName.toLowerCase().trim();

    // Synthetic events from approved offline-time requests (see StatsService.insertManualOfflineEvent)
    if (normalizedName.startsWith('__offline_approval__:')) {
      const suffix = normalizedName.slice('__offline_approval__:'.length);
      if (suffix.startsWith('productive')) return 'productive';
      if (suffix.startsWith('unproductive')) return 'unproductive';
      return 'neutral';
    }

    this.logger.debug(
      `categorizeApp start tenant=${tenantId} user=${userId} appName="${appName}" normalized="${normalizedName}" appType=${appType} url=${url ?? 'N/A'}`,
    );

    // Get user's team rules (with caching)
    const rules = await this.getUserTeamRules(tenantId, userId);
    const rulesFull = await this.getUserTeamRulesFull(tenantId, userId);

    this.logger.debug(
      `categorizeApp rules loaded tenant=${tenantId} user=${userId} rules.size=${rules.size} rulesFullCount=${rulesFull.length}`,
    );

    // Priority 1: URL-based rules (if URL is provided)
    if (url && url.trim() !== '' && appType === 'web') {
      const urlMatch = this.matchURLRules(url, rulesFull);
      if (urlMatch !== null) {
        const result = this.mapCategory(urlMatch);
        this.logger.debug(
          `categorizeApp URL rule match tenant=${tenantId} user=${userId} appType=${appType} url=${url} category=${result}`,
        );
        return result;
      }

      // Priority 2: Domain-based rules
      const domainMatch = this.matchDomainRules(url, rulesFull);
      if (domainMatch !== null) {
        const result = this.mapCategory(domainMatch);
        this.logger.debug(
          `categorizeApp domain rule match tenant=${tenantId} user=${userId} url=${url} category=${result}`,
        );
        return result;
      }
    }

    // Priority 3: Legacy app name rules (backward compatibility)
    if (rules.size > 0) {
      let ruleKey = `${normalizedName}:${appType}`;
      let category = rules.get(ruleKey);
      // When activity is grouped as browser with appType 'web' (e.g. "chrome" + web), also check
      // desktop rule so "Chrome (desktop)" rule applies to browser usage when domain wasn't extracted
      if (category === undefined && appType === 'web' && this.browserAppNames.has(normalizedName)) {
        ruleKey = `${normalizedName}:desktop`;
        category = rules.get(ruleKey);
      }
      if (category !== undefined) {
        const result = this.mapCategory(category);
        this.logger.debug(
          `categorizeApp legacy app_name rule match tenant=${tenantId} user=${userId} key=${ruleKey} category=${result}`,
        );
        return result;
      }
    }

    // No matching rules: treat as unclassified and neutral until admin defines rules
    // Get user's teams to determine teamId for tracking
    const teams = await this.getUserTeams(tenantId, userId);
    const teamId = teams.length > 0 ? teams[0].teamId : null;

    // Extract domain from URL or use appName
    const domainToTrack =
      url && appType === 'web'
        ? this.urlParser.extractDomainFromURL(url) || normalizedName
        : normalizedName;

    this.logger.debug(
      `categorizeApp no-rule match tenant=${tenantId} user=${userId} appType=${appType} track="${domainToTrack}" teamId=${teamId}`,
    );

    // Track as unclassified (async, don't wait). Any errors are logged but don't affect categorization.
    this.unclassifiedTracker
      .trackUnclassifiedApp(tenantId, userId, teamId, domainToTrack, appType as RuleAppType)
      .catch((error) => {
        this.logger.error(
          `Failed to track unclassified app: ${domainToTrack}`,
          error.stack,
        );
      });

    // Until rules exist, all unmatched apps/domains are treated as neutral in analytics.
    this.logger.debug(
      `categorizeApp result (unclassified neutral) tenant=${tenantId} user=${userId} appName="${appName}" appType=${appType}`,
    );
    return 'neutral';
  }

  /**
   * Match URL against URL-based rules (exact and pattern)
   * Priority: URL_EXACT > URL_PATTERN
   */
  private matchURLRules(url: string, rules: TeamProductivityRule[]): RuleAppCategory | null {
    // First try exact URL matches
    for (const rule of rules) {
      if (rule.ruleType === RuleType.URL_EXACT && rule.appType === RuleAppType.WEB) {
        const pattern = rule.pattern || rule.appName;
        if (this.urlParser.matchExactURL(url, pattern)) {
          return rule.category;
        }
      }
    }

    // Then try pattern matches
    for (const rule of rules) {
      if (rule.ruleType === RuleType.URL_PATTERN && rule.appType === RuleAppType.WEB) {
        const pattern = rule.pattern || rule.appName;
        if (this.urlParser.matchPattern(url, pattern)) {
          return rule.category;
        }
      }
    }

    return null;
  }

  /**
   * Match URL against domain-based rules
   */
  private matchDomainRules(url: string, rules: TeamProductivityRule[]): RuleAppCategory | null {
    for (const rule of rules) {
      if (rule.ruleType === RuleType.DOMAIN && rule.appType === RuleAppType.WEB) {
        if (this.urlParser.matchDomain(url, rule.appName)) {
          return rule.category;
        }
      }
    }

    return null;
  }

  /**
   * Get user's team rules (cached)
   */
  private async getUserTeamRules(
    tenantId: number,
    userId: number,
  ): Promise<Map<string, RuleAppCategory>> {
    const cacheKey = `${tenantId}:${userId}`;
    const now = Date.now();

    // Check cache
    const cached = this.rulesCache.get(cacheKey);
    const expiry = this.cacheExpiry.get(cacheKey) || 0;

    if (cached && expiry > now) {
      this.logger.debug(
        `getUserTeamRules cache hit tenant=${tenantId} user=${userId} rules.size=${cached.size}`,
      );
      return cached;
    }

    // Fetch from database
    try {
      // Get user's teams
      const teams = await this.getUserTeams(tenantId, userId);
      if (teams.length === 0) {
        // No teams, return empty map
        const emptyMap = new Map<string, RuleAppCategory>();
        this.rulesCache.set(cacheKey, emptyMap);
        this.cacheExpiry.set(cacheKey, now + this.CACHE_TTL_MS);
        return emptyMap;
      }

      const teamIds = teams.map((tm) => tm.teamId);

      // Get all collections assigned to user's teams
      const collectionAssignments = await this.collectionTeamsRepository.find({
        where: {
          teamId: In(teamIds),
        },
      });

      const collectionIds = collectionAssignments.map((ca) => ca.collectionId);

      // Get all rules from collections AND legacy rules (without collectionId) for backward compatibility
      const rules = await this.rulesRepository.find({
        where: collectionIds.length > 0
          ? [
              // Rules from collections
              {
                collectionId: In(collectionIds),
              },
              // Legacy rules (without collectionId) for backward compatibility
              {
                teamId: In(teamIds),
                collectionId: IsNull(),
              },
            ]
          : [
              // Only legacy rules if no collections
              {
                teamId: In(teamIds),
                collectionId: IsNull(),
              },
            ],
      });

      // Build map: "appName:appType" -> category (for legacy app_name rules)
      const rulesMap = new Map<string, RuleAppCategory>();
      for (const rule of rules) {
        // Only cache app_name rules in legacy format
        if (rule.ruleType === RuleType.APP_NAME) {
          const key = `${rule.appName}:${rule.appType}`;
          // Union: if multiple teams have rules, first match wins
          if (!rulesMap.has(key)) {
            rulesMap.set(key, rule.category);
          }
        }
      }

      // Cache the results
      this.rulesCache.set(cacheKey, rulesMap);
      this.rulesCacheFull.set(cacheKey, rules);
      this.cacheExpiry.set(cacheKey, now + this.CACHE_TTL_MS);

      this.logger.debug(
        `getUserTeamRules cache miss tenant=${tenantId} user=${userId} teams=${teams.length} teamIds=${teamIds.join(',')} collections=${collectionIds.length} rules=${rules.length} mappedKeys=${rulesMap.size}`,
      );

      return rulesMap;
    } catch (error) {
      this.logger.error(
        `Failed to fetch team rules for user ${userId}`,
        error.stack,
      );
      // Return empty map on error (will use fallback)
      return new Map<string, RuleAppCategory>();
    }
  }

  /**
   * Get user's team rules as full objects (for URL/domain matching)
   */
  private async getUserTeamRulesFull(
    tenantId: number,
    userId: number,
  ): Promise<TeamProductivityRule[]> {
    const cacheKey = `${tenantId}:${userId}`;
    const now = Date.now();

    // Check cache
    const cached = this.rulesCacheFull.get(cacheKey);
    const expiry = this.cacheExpiry.get(cacheKey) || 0;

    if (cached && expiry > now) {
      this.logger.debug(
        `getUserTeamRulesFull cache hit tenant=${tenantId} user=${userId} rulesFullCount=${cached.length}`,
      );
      return cached;
    }

    // Fetch from database (same query as getUserTeamRules)
    try {
      // Get user's teams
      const teams = await this.getUserTeams(tenantId, userId);

      if (teams.length === 0) {
        const emptyArray: TeamProductivityRule[] = [];
        this.rulesCacheFull.set(cacheKey, emptyArray);
        this.cacheExpiry.set(cacheKey, now + this.CACHE_TTL_MS);
        return emptyArray;
      }

      const teamIds = teams.map((tm) => tm.teamId);

      // Get all collections assigned to user's teams
      const collectionAssignments = await this.collectionTeamsRepository.find({
        where: {
          teamId: In(teamIds),
        },
      });

      const collectionIds = collectionAssignments.map((ca) => ca.collectionId);

      // Get all rules from collections AND legacy rules (without collectionId) for backward compatibility
      const rules = await this.rulesRepository.find({
        where: collectionIds.length > 0
          ? [
              // Rules from collections
              {
                collectionId: In(collectionIds),
              },
              // Legacy rules (without collectionId) for backward compatibility
              {
                teamId: In(teamIds),
                collectionId: IsNull(),
              },
            ]
          : [
              // Only legacy rules if no collections
              {
                teamId: In(teamIds),
                collectionId: IsNull(),
              },
            ],
      });

      // Cache the result
      this.rulesCacheFull.set(cacheKey, rules);
      this.cacheExpiry.set(cacheKey, now + this.CACHE_TTL_MS);

      this.logger.debug(
        `getUserTeamRulesFull cache miss tenant=${tenantId} user=${userId} teams=${teams.length} teamIds=${teamIds.join(',')} collections=${collectionIds.length} rules=${rules.length}`,
      );

      return rules;
    } catch (error) {
      this.logger.error(
        `Failed to fetch team rules for user ${userId}`,
        error.stack,
      );
      return [];
    }
  }

  /**
   * Get user's teams
   * Note: We trust backend data integrity - teams are already scoped to tenant
   */
  private async getUserTeams(
    tenantId: number,
    userId: number,
  ): Promise<TeamMember[]> {
    try {
      // Get all team memberships for this user
      // Backend ensures teams belong to the tenant, so we can trust the data
      return await this.teamMembersRepository.find({
        where: { userId },
      });
    } catch (error) {
      this.logger.error(
        `Failed to fetch teams for user ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return [];
    }
  }

  /**
   * Map database category to interface category
   */
  private mapCategory(category: RuleAppCategory): AppCategory {
    switch (category) {
      case RuleAppCategory.PRODUCTIVE:
        return 'productive';
      case RuleAppCategory.UNPRODUCTIVE:
        return 'unproductive';
      case RuleAppCategory.NEUTRAL:
        return 'neutral';
      default:
        return 'neutral';
    }
  }

  /**
   * Clear cache for a user (call when rules are updated)
   */
  clearUserCache(tenantId: number, userId: number): void {
    const cacheKey = `${tenantId}:${userId}`;
    this.rulesCache.delete(cacheKey);
    this.rulesCacheFull.delete(cacheKey);
    this.cacheExpiry.delete(cacheKey);
  }

  /**
   * Clear all cache
   */
  clearAllCache(): void {
    this.rulesCache.clear();
    this.cacheExpiry.clear();
  }
}
