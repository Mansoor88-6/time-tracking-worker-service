import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RawEventEntity } from '../timescale/entities/raw-event.entity';

/**
 * Health Check Module
 *
 * Provides HTTP endpoints for health monitoring.
 * Note: Requires HTTP server to be enabled in main.ts
 */
@Module({
  imports: [TypeOrmModule.forFeature([RawEventEntity])],
  controllers: [HealthController],
})
export class HealthModule {}
