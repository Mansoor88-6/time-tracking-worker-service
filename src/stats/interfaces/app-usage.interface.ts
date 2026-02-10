/**
 * App Usage Interfaces
 *
 * Defines types for app usage statistics aggregation and categorization.
 */

export type AppCategory = 'productive' | 'unproductive' | 'neutral';
export type AppType = 'desktop' | 'web';

/**
 * URL/Title breakdown for an app
 * Shows time spent on different URLs or window titles within an application
 */
export interface UrlBreakdown {
  title: string | null; // Page title or null
  url: string | null; // Full URL or null
  displayName: string; // Formatted display name (title or URL domain)
  productiveTimeMs: number;
}

/**
 * Individual app usage statistics
 */
export interface AppUsage {
  appName: string;
  appType: AppType;
  productiveTimeMs: number;
  category: AppCategory;
  urlBreakdown: UrlBreakdown[]; // Breakdown by URL/title
}

/**
 * Aggregated app usage statistics grouped by category
 */
export interface AppUsageStats {
  productive: AppUsage[];
  unproductive: AppUsage[];
  neutral: AppUsage[];
  totals: {
    productive: number; // Total productive time in ms
    unproductive: number; // Total unproductive time in ms
    neutral: number; // Total neutral time in ms
  };
}

/**
 * Raw app usage data from database (before categorization)
 */
export interface RawAppUsage {
  appName: string;
  appType: AppType;
  productiveTimeMs: number;
  urlBreakdown: UrlBreakdown[]; // Breakdown by URL/title
}
