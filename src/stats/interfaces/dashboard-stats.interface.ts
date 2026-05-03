/**
 * Dashboard Stats Response Interface
 *
 * Represents aggregated statistics for a user's dashboard.
 * All time values are in milliseconds unless otherwise specified.
 */
export interface DashboardStats {
  /** Earliest wall-clock start among non-offline events (aligns with timeline first bar). */
  arrivalTime: Date | null;
  /** Latest wall-clock end among non-offline events, or null if still considered online. */
  leftTime: Date | null;
  isOnline: boolean; // True if user is currently active (within activity window)
  /**
   * Total time that was actively spent on apps/domains and classified as productive.
   * Implementation detail: backed by active_duration_ms (with fallback to duration_ms for legacy rows).
   */
  productiveTimeMs: number;
  /**
   * Total tracked time at the machine while not offline.
   * Implementation detail: backed by total duration (active + idle/away), still using duration_ms as the presence baseline.
   */
  deskTimeMs: number;
  /**
   * Wall-clock presence excluding offline gaps (from arrival to last activity/now),
   * regardless of whether time was active or idle.
   */
  timeAtWorkMs: number;
  productivityScorePct: number; // productiveTimeMs / deskTimeMs * 100 (0-100)
  effectivenessPct: number; // productiveTimeMs / timeAtWorkMs * 100 (0-100)
  /**
   * Total active time on events that are associated with a project.
   * Implementation detail: backed by active_duration_ms for status='active' events with project_id.
   */
  projectsTimeMs: number;
  /** Rule-based totals (present when single-date); aligns with app usage totals */
  unproductiveTimeMs?: number;
  neutralTimeMs?: number;
}
