import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * RawEvent Entity
 *
 * Represents a single time-tracking event stored in TimescaleDB.
 * This table is converted to a hypertable for efficient time-series queries.
 *
 * Indexes:
 * - Primary time index on 'time' (required for hypertable)
 * - Composite indexes for common query patterns (tenant_id + time, user_id + time, device_id + time)
 * - Unique constraint on (tenant_id, device_id, timestamp) for idempotency
 *
 * NOTE:
 * Index decorators must refer to **property names**, not database column
 * names. The `name` property on @Column handles the DB column mapping.
 */
@Entity('raw_events')
@Index(['tenantId', 'time'])
@Index(['userId', 'time'])
@Index(['deviceId', 'time'])
@Index(['tenantId', 'deviceId', 'timestamp'], { unique: true })
export class RawEventEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: bigint;

  /**
   * Time column for TimescaleDB hypertable partitioning.
   * This is the primary time dimension for time-series queries.
   */
  @Column({ type: 'timestamptz', name: 'time' })
  time: Date;

  @Column({ type: 'integer', name: 'tenant_id' })
  tenantId: number;

  @Column({ type: 'integer', name: 'user_id' })
  userId: number;

  @Column({ type: 'varchar', length: 255, name: 'device_id' })
  deviceId: string;

  /**
   * Original event timestamp from the client (Unix milliseconds).
   * Used for idempotency constraint along with tenant_id and device_id.
   */
  @Column({ type: 'bigint', name: 'timestamp' })
  timestamp: number;

  @Column({ type: 'varchar', length: 50, name: 'status' })
  status: string;

  @Column({ type: 'varchar', length: 255, name: 'application', nullable: true })
  application?: string;

  @Column({ type: 'text', name: 'title', nullable: true })
  title?: string;

  @Column({ type: 'text', name: 'url', nullable: true })
  url?: string;

  @Column({ type: 'bigint', name: 'duration_ms', nullable: true })
  durationMs?: number;

  @Column({ type: 'varchar', length: 255, name: 'project_id', nullable: true })
  projectId?: string;

  /**
   * Timestamp when the event was ingested by the worker service.
   * Useful for monitoring ingestion latency and supporting future aggregation windows.
   */
  @CreateDateColumn({ type: 'timestamptz', name: 'ingested_at' })
  ingestedAt: Date;
}
