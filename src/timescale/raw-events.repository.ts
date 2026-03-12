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
}
