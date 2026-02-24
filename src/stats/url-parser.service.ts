import { Injectable } from '@nestjs/common';

export interface ParsedURL {
  domain: string;
  path: string;
  fullPath: string;
  protocol: string;
  hostname: string;
}

/**
 * URL Parser Service
 *
 * Provides utilities for parsing URLs, extracting domains, and normalizing
 * for rule matching purposes.
 */
@Injectable()
export class URLParserService {
  /**
   * Parse a full URL into its components
   */
  parseURL(url: string): ParsedURL | null {
    if (!url || url.trim() === '') {
      return null;
    }

    try {
      // Ensure URL has protocol for URL constructor
      let urlToParse = url.trim();
      if (
        !urlToParse.startsWith('http://') &&
        !urlToParse.startsWith('https://')
      ) {
        urlToParse = 'https://' + urlToParse;
      }

      const urlObj = new URL(urlToParse);
      const domain = this.normalizeDomain(urlObj.hostname);
      const path = urlObj.pathname || '/';
      // Include query string in fullPath so exact-URL rules match (e.g. ?tab=repositories)
      const fullPath = domain + path + (urlObj.search || '');

      return {
        domain,
        path,
        fullPath,
        protocol: urlObj.protocol.replace(':', ''),
        hostname: urlObj.hostname,
      };
    } catch {
      // If URL parsing fails, try simple domain extraction
      return this.parseSimpleURL(url);
    }
  }

  /**
   * Parse URL using simple string manipulation (fallback)
   */
  private parseSimpleURL(url: string): ParsedURL | null {
    try {
      // Remove protocol
      const cleanUrl = url.replace(/^https?:\/\//, '');

      // Extract domain and path
      const parts = cleanUrl.split('/');
      const domain = this.normalizeDomain(parts[0]);
      const path = '/' + parts.slice(1).join('/');

      return {
        domain,
        path: path === '/' ? '/' : path,
        fullPath: domain + path,
        protocol: url.startsWith('http://') ? 'http' : 'https',
        hostname: parts[0],
      };
    } catch {
      return null;
    }
  }

  /**
   * Extract and normalize domain from URL
   */
  extractDomainFromURL(url: string): string | null {
    const parsed = this.parseURL(url);
    return parsed?.domain || null;
  }

  /**
   * Normalize domain name
   * - Remove www. prefix
   * - Convert to lowercase
   * - Handle edge cases
   */
  normalizeDomain(domain: string): string {
    if (!domain) {
      return '';
    }

    let normalized = domain.toLowerCase().trim();

    // Remove www. prefix
    if (normalized.startsWith('www.')) {
      normalized = normalized.substring(4);
    }

    // Remove trailing slash if present
    normalized = normalized.replace(/\/$/, '');

    // Handle localhost and IP addresses
    if (normalized === 'localhost' || this.isIPAddress(normalized)) {
      return normalized;
    }

    return normalized;
  }

  /**
   * Check if a string is an IP address
   */
  private isIPAddress(str: string): boolean {
    // IPv4
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (ipv4Regex.test(str)) {
      return true;
    }

    // IPv6 (simplified check)
    const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
    return ipv6Regex.test(str);
  }

  /**
   * Match URL against a pattern
   * Supports wildcards: asterisk character matches any sequence of characters
   *
   * @param url - The URL to match against
   * @param pattern - The pattern to match (supports wildcards)
   * @returns True if the URL matches the pattern
   */
  matchPattern(url: string, pattern: string): boolean {
    if (!url || !pattern) {
      return false;
    }

    const parsed = this.parseURL(url);
    if (!parsed) {
      return false;
    }

    // Normalize pattern
    const normalizedPattern = pattern.toLowerCase().trim();

    // Convert pattern to regex
    // Escape special regex characters except *
    const regexPattern = normalizedPattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
      .replace(/\*/g, '.*'); // Convert * to .*

    // Match against full path (domain + path)
    const fullPathRegex = new RegExp(`^${regexPattern}$`);
    if (fullPathRegex.test(parsed.fullPath)) {
      return true;
    }

    // Match against domain only
    const domainRegex = new RegExp(`^${regexPattern}$`);
    if (domainRegex.test(parsed.domain)) {
      return true;
    }

    return false;
  }

  /**
   * Check if URL matches an exact pattern (no wildcards)
   */
  matchExactURL(url: string, pattern: string): boolean {
    if (!url || !pattern) {
      return false;
    }

    const parsed = this.parseURL(url);
    if (!parsed) {
      return false;
    }

    const normalizedPattern = pattern.toLowerCase().trim();
    const normalizedFullPath = parsed.fullPath.toLowerCase();

    // Try matching full path
    if (normalizedFullPath === normalizedPattern) {
      return true;
    }

    // Try matching domain + path without leading protocol
    const patternWithoutProtocol = normalizedPattern.replace(
      /^https?:\/\//,
      '',
    );
    if (normalizedFullPath === patternWithoutProtocol) {
      return true;
    }

    return false;
  }

  /**
   * Check if URL's domain matches the given domain
   */
  matchDomain(url: string, domain: string): boolean {
    if (!url || !domain) {
      return false;
    }

    const parsed = this.parseURL(url);
    if (!parsed) {
      return false;
    }

    const normalizedDomain = this.normalizeDomain(domain);
    return parsed.domain === normalizedDomain;
  }

  /**
   * Extract domain from appName (for backward compatibility)
   * If appName is already a domain, return it normalized
   */
  extractDomainFromAppName(appName: string): string | null {
    if (!appName) {
      return null;
    }

    // If it looks like a URL, parse it
    if (appName.includes('://') || appName.includes('/')) {
      return this.extractDomainFromURL(appName);
    }

    // Otherwise, treat as domain and normalize
    return this.normalizeDomain(appName);
  }
}
