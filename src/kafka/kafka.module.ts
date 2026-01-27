import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getKafkaConfig } from './kafka.config';

/**
 * Kafka Module for Worker Service
 *
 * Provides Kafka microservice configuration for consuming events.
 * This module is imported by AppModule to enable Kafka message consumption.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'KAFKA_CONFIG',
      useFactory: (configService: ConfigService) => getKafkaConfig(configService),
      inject: [ConfigService],
    },
  ],
  exports: ['KAFKA_CONFIG'],
})
export class KafkaModule {}
