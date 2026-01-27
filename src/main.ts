import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { getKafkaConfig } from './kafka/kafka.config';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Create the NestJS application context
  // We create a hybrid app (HTTP + Microservice) to enable health checks
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // Get Kafka configuration
  const kafkaConfig = getKafkaConfig(configService);

  // Connect as a Kafka microservice
  app.connectMicroservice<MicroserviceOptions>(kafkaConfig);

  // Start HTTP server for health checks (optional, but useful for monitoring)
  const httpPort = configService.get<number>('PORT') || 3300;
  await app.listen(httpPort);

  // Start all microservices
  await app.startAllMicroservices();

  logger.log('🚀 Worker service started');
  logger.log(`🌐 HTTP server listening on port ${httpPort} (health checks)`);
  logger.log(
    `📡 Kafka microservice connected to broker: ${configService.get<string>('kafka.broker')}`,
  );
  logger.log(
    `📦 Consuming from topic: ${configService.get<string>('kafka.topicRawEvents')}`,
  );
  logger.log(
    `👥 Consumer group: ${configService.get<string>('kafka.groupId')}`,
  );
  logger.log(
    `💾 TimescaleDB: ${configService.get<string>('timescale.host')}:${configService.get<number>('timescale.port')}/${configService.get<string>('timescale.database')}`,
  );
}

bootstrap().catch((error) => {
  console.error('Failed to start worker service:', error);
  process.exit(1);
});
