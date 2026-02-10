/**
 * Dashboard Stats Response Interface
 *
 * Represents aggregated statistics for a user's dashboard.
 * All time values are in milliseconds unless otherwise specified.
 */
export interface DashboardStats {
  arrivalTime: Date | null; // First non-offline event time
  leftTime: Date | null; // Last non-offline event time, or null if online
  isOnline: boolean; // True if user is currently active (within activity window)
  productiveTimeMs: number; // Sum of duration_ms where status='active'
  deskTimeMs: number; // Sum of duration_ms where status IN ('active','idle','away')
  timeAtWorkMs: number; // Wall-clock presence excluding offline gaps
  productivityScorePct: number; // productiveTimeMs / deskTimeMs * 100 (0-100)
  effectivenessPct: number; // productiveTimeMs / timeAtWorkMs * 100 (0-100)
  projectsTimeMs: number; // Sum of duration_ms where status='active' AND project_id IS NOT NULL
}
