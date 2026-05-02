import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RawEventEntity } from './entities/raw-event.entity';
import { RawEvent } from '../events-consumer/interfaces/raw-event-message.interface';

/**
 * Raw Events Repository
 *
 * Handles efficient batch insertion of raw events into TimescaleDB.
 * Uses bulk insert operations for optimal performance.
 */
@Injectable()
export class RawEventsRepository {
  private readonly logger = new Logger(RawEventsRepository.name);

  constructor(
    @InjectRepository(RawEventEntity)
    private readonly rawEventRepository: Repository<RawEventEntity>,
  ) {}

  /**
   * Save a batch of raw events to TimescaleDB
   *
   * @param tenantId - Tenant ID
   * @param userId - User ID
   * @param deviceId - Device ID
   * @param events - Array of raw events from the Kafka message
   * @returns Number of events successfully inserted
   */
  async saveBatch(
    tenantId: number,
    userId: number,
    deviceId: string,
    events: RawEvent[],
  ): Promise<number> {
    const startTime = Date.now();

    try {
      // Map events to entity instances
      const entities = events.map((event) => {
        const entity = new RawEventEntity();
        entity.time = new Date(event.timestamp);
        entity.tenantId = tenantId;
        entity.userId = userId;
        entity.deviceId = deviceId;
        entity.timestamp = event.timestamp;
        entity.status = event.status;
        entity.application = event.application;
        entity.title = event.title;
        entity.url = event.url;
        entity.durationMs = event.duration;
        entity.projectId = event.projectId;
        entity.source = event.source;
        entity.tabId = event.tabId;
        entity.windowId = event.windowId;
        entity.sequence = event.sequence;
        entity.startTime = event.startTime;
        entity.endTime = event.endTime;
        entity.activeDurationMs = event.activeDuration;
        entity.idleDurationMs = event.idleDuration;
        return entity;
      });

      // Use TypeORM's save with array for efficient bulk insert
      // TypeORM will batch the inserts automatically
      const saved = await this.rawEventRepository.save(entities, {
        chunk: 500, // Insert in chunks of 500 for very large batches
      });

      const duration = Date.now() - startTime;
      this.logger.log(
        `✅ Saved batch of ${saved.length} events for tenant ${tenantId}, user ${userId}, device ${deviceId} in ${duration}ms`,
      );

      return saved.length;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Check if error is due to duplicate (idempotency constraint violation)
      if (
        errorMessage.includes('duplicate key') ||
        errorMessage.includes('unique constraint')
      ) {
        this.logger.warn(
          `⚠️  Duplicate events detected for tenant ${tenantId}, device ${deviceId}. This is expected if Kafka replays messages.`,
        );
        // Return 0 to indicate no new events were inserted
        return 0;
      }

      this.logger.error(
        `❌ Failed to save batch for tenant ${tenantId}, user ${userId}, device ${deviceId} after ${duration}ms: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Get count of events for a tenant (for monitoring/debugging)
   */
  async countByTenant(tenantId: number): Promise<number> {
    return this.rawEventRepository.count({
      where: { tenantId },
    });
  }

  async deleteUserTimeRange(params: {
    tenantId: number;
    userId: number;
    startMs: number;
    endMs: number;
  }): Promise<{
    deletedEvents: number;
    trimmedEvents: number;
    splitEvents: number;
  }> {
    const { tenantId, userId, startMs, endMs } = params;
    const startTime = Date.now();

    const toNumber = (value: unknown): number => {
      if (typeof value === 'number') return value;
      if (typeof value === 'bigint') return Number(value);
      if (typeof value === 'string') return Number(value);
      return 0;
    };

    const eventStartMs = (event: RawEventEntity): number =>
      event.startTime !== null && event.startTime !== undefined
        ? toNumber(event.startTime)
        : toNumber(event.timestamp);

    const eventEndMs = (event: RawEventEntity): number => {
      if (event.endTime !== null && event.endTime !== undefined) {
        return toNumber(event.endTime);
      }
      const duration = Math.max(0, toNumber(event.durationMs));
      return eventStartMs(event) + duration;
    };

    const applyInterval = (
      event: RawEventEntity,
      intervalStartMs: number,
      intervalEndMs: number,
      originalDurationMs: number,
      originalActiveMs: number,
      originalIdleMs: number,
    ): void => {
      const duration = Math.max(0, intervalEndMs - intervalStartMs);
      const totalLabeled = originalActiveMs + originalIdleMs;
      const activeRatio =
        totalLabeled > 0
          ? originalActiveMs / originalDurationMs
          : event.status === 'active'
            ? 1
            : 0;
      const idleRatio =
        totalLabeled > 0
          ? originalIdleMs / originalDurationMs
          : event.status === 'idle' || event.status === 'away'
            ? 1
            : 0;

      event.time = new Date(intervalStartMs);
      event.timestamp = intervalStartMs;
      event.startTime = intervalStartMs;
      event.endTime = intervalEndMs;
      event.durationMs = duration;
      event.activeDurationMs = Math.round(duration * activeRatio);
      event.idleDurationMs = Math.round(duration * idleRatio);
    };

    return this.rawEventRepository.manager.transaction(async (manager) => {
      const events = await manager
        .createQueryBuilder(RawEventEntity, 'event')
        .where('event.tenant_id = :tenantId', { tenantId })
        .andWhere('event.user_id = :userId', { userId })
        .andWhere(
          'COALESCE(event.start_time, event.timestamp) < :endMs',
          { endMs },
        )
        .andWhere(
          '(CASE WHEN event.end_time IS NOT NULL THEN event.end_time ELSE COALESCE(event.start_time, event.timestamp) + COALESCE(event.duration_ms, 0) END) > :startMs',
          { startMs },
        )
        .getMany();

      let deletedEvents = 0;
      let trimmedEvents = 0;
      let splitEvents = 0;

      for (const event of events) {
        const originalStart = eventStartMs(event);
        const originalEnd = eventEndMs(event);
        const originalDuration = Math.max(0, originalEnd - originalStart);
        if (originalDuration <= 0) continue;

        const keepLeft = originalStart < startMs;
        const keepRight = originalEnd > endMs;
        const originalActive = toNumber(event.activeDurationMs);
        const originalIdle = toNumber(event.idleDurationMs);

        if (!keepLeft && !keepRight) {
          await manager.remove(RawEventEntity, event);
          deletedEvents += 1;
          continue;
        }

        if (keepLeft && keepRight) {
          const right = manager.create(RawEventEntity, {
            tenantId: event.tenantId,
            userId: event.userId,
            deviceId: event.deviceId,
            status: event.status,
            application: event.application,
            title: event.title,
            url: event.url,
            projectId: event.projectId,
            source: event.source,
            tabId: event.tabId,
            windowId: event.windowId,
            sequence: event.sequence,
          });
          applyInterval(
            right,
            endMs,
            originalEnd,
            originalDuration,
            originalActive,
            originalIdle,
          );
          applyInterval(
            event,
            originalStart,
            startMs,
            originalDuration,
            originalActive,
            originalIdle,
          );
          await manager.save(RawEventEntity, [event, right]);
          splitEvents += 1;
          continue;
        }

        if (keepLeft) {
          applyInterval(
            event,
            originalStart,
            startMs,
            originalDuration,
            originalActive,
            originalIdle,
          );
        } else {
          applyInterval(
            event,
            endMs,
            originalEnd,
            originalDuration,
            originalActive,
            originalIdle,
          );
        }
        await manager.save(RawEventEntity, event);
        trimmedEvents += 1;
      }

      this.logger.log(
        `Deleted tracked time range for tenant=${tenantId}, user=${userId}, ${new Date(startMs).toISOString()}-${new Date(endMs).toISOString()} in ${Date.now() - startTime}ms: deleted=${deletedEvents}, trimmed=${trimmedEvents}, split=${splitEvents}`,
      );

      return { deletedEvents, trimmedEvents, splitEvents };
    });
  }
}
