import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload, Ctx, KafkaContext } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { RawEventsRepository } from '../timescale/raw-events.repository';
import type { RawEventMessage } from './interfaces/raw-event-message.interface';

/**
 * Events Consumer Controller
 *
 * Consumes raw event batches from the Kafka 'raw-events' topic
 * and persists them to TimescaleDB.
 *
 * Topic: raw-events
 * Consumer Group: raw-events-worker (configured in kafka.config.ts)
 *
 * Note: In NestJS microservices, @EventPattern handlers must be in a Controller,
 * not a Service, for the microservice to properly register and route messages.
 */
@Controller()
export class EventsConsumerService {
  private readonly logger = new Logger(EventsConsumerService.name);
  private readonly topicName: string;

  constructor(
    private readonly rawEventsRepository: RawEventsRepository,
    private readonly configService: ConfigService,
  ) {
    this.topicName =
      this.configService.get<string>('kafka.topicRawEvents') || 'raw-events';
  }

  /**
   * Handle incoming raw event batches from Kafka
   *
   * @param data - Raw event message payload
   * @param context - Kafka context containing partition, offset, etc.
   */
  @EventPattern('raw-events')
  async handleRawEvents(
    @Payload() data: RawEventMessage,
    @Ctx() context: KafkaContext,
  ): Promise<void> {
    const startTime = Date.now();
    const partition = context.getPartition();
    const topic = context.getTopic();
    // Get offset from message if available
    const message = context.getMessage();
    const offset = message?.offset?.toString() || 'unknown';

    this.logger.log(
      `📥 Received batch from topic=${topic}, partition=${partition}, offset=${offset}, tenantId=${data.tenantId}, deviceId=${data.deviceId}, events=${data.events?.length || 0}`,
    );

    try {
      // Validate message structure
      if (!data || !data.events || !Array.isArray(data.events)) {
        throw new Error('Invalid message structure: missing or invalid events array');
      }

      if (!data.tenantId || !data.userId || !data.deviceId) {
        throw new Error(
          'Invalid message structure: missing tenantId, userId, or deviceId',
        );
      }

      if (data.events.length === 0) {
        this.logger.warn(
          `⚠️  Empty batch received for tenant ${data.tenantId}, device ${data.deviceId}. Skipping.`,
        );
        return;
      }

      // Persist events to TimescaleDB
      const savedCount = await this.rawEventsRepository.saveBatch(
        data.tenantId,
        data.userId,
        data.deviceId,
        data.events,
      );

      const duration = Date.now() - startTime;
      this.logger.log(
        `✅ Processed batch: tenant=${data.tenantId}, user=${data.userId}, device=${data.deviceId}, saved=${savedCount}/${data.events.length} events in ${duration}ms`,
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error(
        `❌ Failed to process batch: topic=${topic}, partition=${partition}, offset=${offset}, tenantId=${data?.tenantId}, deviceId=${data?.deviceId} after ${duration}ms: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );

      // In production, you might want to:
      // 1. Send failed messages to a dead-letter topic (raw-events-dlq)
      // 2. Implement retry logic with exponential backoff
      // 3. Alert monitoring systems
      //
      // For now, we log the error and let Kafka handle retries via consumer group offset management
      // If processing fails, the offset won't be committed, and Kafka will redeliver the message
      throw error; // Re-throw to prevent offset commit, allowing Kafka to retry
    }
  }
}
