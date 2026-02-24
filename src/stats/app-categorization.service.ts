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

  // Fallback: Productive desktop applications (for backward compatibility)
  private readonly productiveDesktopApps = new Set([
    'cursor',
    'code',
    'visual studio code',
    'vscode',
    'intellij',
    'idea',
    'webstorm',
    'pycharm',
    'android studio',
    'xcode',
    'sublime text',
    'atom',
    'vim',
    'neovim',
    'emacs',
    'terminal',
    'windows terminal',
    'windowsterminal',
    'powershell',
    'cmd',
    'iterm',
    'dbeaver',
    'datagrip',
    'postman',
    'insomnia',
    'fiddler',
    'wireshark',
    'docker',
    'kubernetes',
    'git',
    'github desktop',
    'sourcetree',
    'tortoisegit',
  ]);

  // Fallback: Unproductive desktop applications
  private readonly unproductiveDesktopApps = new Set([
    'steam',
    'epic games launcher',
    'discord',
    'slack',
    'telegram',
    'whatsapp',
    'spotify',
    'itunes',
    'netflix',
    'vlc',
    'media player',
  ]);

  // Fallback: Productive web domains
  private readonly productiveWebDomains = new Set([
    'github.com',
    'gitlab.com',
    'bitbucket.org',
    'stackoverflow.com',
    'stackexchange.com',
    'dev.to',
    'medium.com',
    'docs.google.com',
    'confluence',
    'jira',
    'notion.so',
    'atlassian.com',
    'azure.com',
    'aws.amazon.com',
    'cloud.google.com',
    'digitalocean.com',
    'heroku.com',
    'vercel.com',
    'netlify.com',
    'npmjs.com',
    'pypi.org',
    'maven.apache.org',
    'nuget.org',
    'docker.com',
    'kubernetes.io',
    'terraform.io',
    'ansible.com',
    'redhat.com',
    'microsoft.com',
    'developer.mozilla.org',
    'w3.org',
    'mdn.io',
    'react.dev',
    'angular.io',
    'vuejs.org',
    'nodejs.org',
    'python.org',
    'golang.org',
    'rust-lang.org',
    'typescriptlang.org',
  ]);

  // Fallback: Unproductive web domains
  private readonly unproductiveWebDomains = new Set([
    'facebook.com',
    'twitter.com',
    'x.com',
    'instagram.com',
    'linkedin.com',
    'tiktok.com',
    'snapchat.com',
    'reddit.com',
    'youtube.com',
    'netflix.com',
    'hulu.com',
    'disney.com',
    'amazon.com',
    'ebay.com',
    'etsy.com',
    'pinterest.com',
    'tumblr.com',
    'twitch.tv',
    'discord.com',
    'messenger.com',
  ]);

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

  // Fallback: Neutral desktop applications
  private readonly neutralDesktopApps = new Set([
    'explorer',
    'windows explorer',
    'file explorer',
    'finder',
    'settings',
    'control panel',
    'task manager',
    'system',
    'windows',
    'microsoft edge',
    'edge',
    'chrome',
    'firefox',
    'safari',
    'opera',
    'brave',
    'outlook',
    'thunderbird',
    'mail',
    'calendar',
    'notes',
    'notepad',
    'textedit',
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

    // Get user's team rules (with caching)
    const rules = await this.getUserTeamRules(tenantId, userId);
    const rulesFull = await this.getUserTeamRulesFull(tenantId, userId);

    // Priority 1: URL-based rules (if URL is provided)
    if (url && url.trim() !== '' && appType === 'web') {
      const urlMatch = this.matchURLRules(url, rulesFull);
      if (urlMatch !== null) {
        return this.mapCategory(urlMatch);
      }

      // Priority 2: Domain-based rules
      const domainMatch = this.matchDomainRules(url, rulesFull);
      if (domainMatch !== null) {
        return this.mapCategory(domainMatch);
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
        return this.mapCategory(category);
      }
    }

    // Priority 4: Fallback rules
    const fallbackCategory = this.categorizeWithFallback(normalizedName, appType);

    // If fallback also returns neutral and we have no team rules, track as unclassified
    if (fallbackCategory === 'neutral' && rules.size === 0 && rulesFull.length === 0) {
      // Get user's teams to determine teamId for tracking
      const teams = await this.getUserTeams(tenantId, userId);
      const teamId = teams.length > 0 ? teams[0].teamId : null;

      // Extract domain from URL or use appName
      const domainToTrack = url && appType === 'web' 
        ? this.urlParser.extractDomainFromURL(url) || normalizedName
        : normalizedName;

      // Track as unclassified (async, don't wait)
      this.unclassifiedTracker
        .trackUnclassifiedApp(tenantId, userId, teamId, domainToTrack, appType as RuleAppType)
        .catch((error) => {
          this.logger.error(
            `Failed to track unclassified app: ${domainToTrack}`,
            error.stack,
          );
        });
    }

    return fallbackCategory;
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
   * Categorize using fallback rules (backward compatibility)
   */
  private categorizeWithFallback(
    normalizedName: string,
    appType: AppType,
  ): AppCategory {
    if (appType === 'desktop') {
      // Check productive apps first
      if (this.productiveDesktopApps.has(normalizedName)) {
        return 'productive';
      }

      // Check unproductive apps
      if (this.unproductiveDesktopApps.has(normalizedName)) {
        return 'unproductive';
      }

      // Check neutral apps
      if (this.neutralDesktopApps.has(normalizedName)) {
        return 'neutral';
      }

      // Check partial matches for productive apps
      for (const productiveApp of this.productiveDesktopApps) {
        if (normalizedName.includes(productiveApp) || productiveApp.includes(normalizedName)) {
          return 'productive';
        }
      }

      // Check partial matches for unproductive apps
      for (const unproductiveApp of this.unproductiveDesktopApps) {
        if (
          normalizedName.includes(unproductiveApp) ||
          unproductiveApp.includes(normalizedName)
        ) {
          return 'unproductive';
        }
      }
    } else if (appType === 'web') {
      // Extract domain from URL if needed
      let domain = normalizedName;
      try {
        if (normalizedName.startsWith('http://') || normalizedName.startsWith('https://')) {
          const url = new URL(normalizedName);
          domain = url.hostname.replace('www.', '');
        } else if (normalizedName.includes('/')) {
          domain = normalizedName.split('/')[0].replace('www.', '');
        } else {
          domain = normalizedName.replace('www.', '');
        }
      } catch {
        domain = normalizedName.replace('www.', '');
      }

      // Check productive domains
      if (this.productiveWebDomains.has(domain)) {
        return 'productive';
      }

      // Check unproductive domains
      if (this.unproductiveWebDomains.has(domain)) {
        return 'unproductive';
      }

      // Check partial matches for productive domains
      for (const productiveDomain of this.productiveWebDomains) {
        if (domain.includes(productiveDomain) || productiveDomain.includes(domain)) {
          return 'productive';
        }
      }

      // Check partial matches for unproductive domains
      for (const unproductiveDomain of this.unproductiveWebDomains) {
        if (domain.includes(unproductiveDomain) || unproductiveDomain.includes(domain)) {
          return 'unproductive';
        }
      }
    }

    // Default to neutral for unknown apps
    return 'neutral';
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
