import { Transport } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { KafkaOptions } from '@nestjs/microservices/interfaces/microservice-configuration.interface';

/**
 * Kafka Configuration for Worker Service
 *
 * This worker service only consumes messages (no producer needed).
 * It uses a dedicated consumer group to allow multiple worker instances
 * to process messages in parallel while ensuring each message is processed once.
 */
export const getKafkaConfig = (
  configService: ConfigService,
): KafkaOptions => {
  const broker = configService.get<string>('kafka.broker') || '51.91.156.207:9092';
  const clientId =
    configService.get<string>('kafka.clientId') || 'time-tracking-worker';
  const groupId =
    configService.get<string>('kafka.groupId') || 'raw-events-worker';

  return {
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId,
        brokers: [broker],
        retry: {
          retries: 5,
          initialRetryTime: 100,
          multiplier: 2,
        },
      },
      consumer: {
        groupId,
        allowAutoTopicCreation: true,
        // Enable reading from the beginning for new consumer groups
        // In production, you may want to start from latest for new deployments
        // fromBeginning: false,
      },
      // No producer configuration needed for worker service
    },
  };
};
