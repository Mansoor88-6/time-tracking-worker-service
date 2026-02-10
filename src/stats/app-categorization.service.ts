import { Injectable, Logger } from '@nestjs/common';
import type { AppCategory, AppType } from './interfaces/app-usage.interface';

/**
 * App Categorization Service
 *
 * Categorizes applications as productive, unproductive, or neutral.
 * Uses default rules that can be extended with per-tenant/user configuration in the future.
 */
@Injectable()
export class AppCategorizationService {
  private readonly logger = new Logger(AppCategorizationService.name);

  // Productive desktop applications
  private readonly productiveDesktopApps = new Set([
    'cursor',
    'code', // VS Code
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

  // Unproductive desktop applications
  private readonly unproductiveDesktopApps = new Set([
    'steam',
    'epic games launcher',
    'discord',
    'slack', // Could be productive, but defaulting to unproductive for now
    'telegram',
    'whatsapp',
    'spotify',
    'itunes',
    'netflix',
    'vlc',
    'media player',
  ]);

  // Productive web domains
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

  // Unproductive web domains
  private readonly unproductiveWebDomains = new Set([
    'facebook.com',
    'twitter.com',
    'x.com',
    'instagram.com',
    'linkedin.com', // Could be productive, but defaulting to unproductive
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

  // Neutral desktop applications (system apps, utilities)
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

  /**
   * Categorize an application based on its name and type
   *
   * @param appName - Application name (desktop app) or domain (web app)
   * @param appType - Type of application (desktop or web)
   * @returns Category: productive, unproductive, or neutral
   */
  categorizeApp(appName: string, appType: AppType): AppCategory {
    if (!appName || appName.trim() === '') {
      return 'neutral';
    }

    const normalizedName = appName.toLowerCase().trim();

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

      // Check partial matches for productive apps (e.g., "Cursor" contains "cursor")
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
        // If it's a full URL, extract domain
        if (normalizedName.startsWith('http://') || normalizedName.startsWith('https://')) {
          const url = new URL(normalizedName);
          domain = url.hostname.replace('www.', '');
        } else if (normalizedName.includes('/')) {
          // If it's domain/path, extract just domain
          domain = normalizedName.split('/')[0].replace('www.', '');
        } else {
          domain = normalizedName.replace('www.', '');
        }
      } catch {
        // If URL parsing fails, use the name as-is
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
   * Check if an app name matches a pattern (case-insensitive, partial match)
   */
  private matchesPattern(name: string, pattern: string): boolean {
    const normalizedName = name.toLowerCase();
    const normalizedPattern = pattern.toLowerCase();
    return (
      normalizedName === normalizedPattern ||
      normalizedName.includes(normalizedPattern) ||
      normalizedPattern.includes(normalizedName)
    );
  }
}
