import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';
import { StatsRepository } from './stats.repository';
import { AppCategorizationService } from './app-categorization.service';
import { RawEventEntity } from '../timescale/entities/raw-event.entity';

/**
 * Stats Module
 *
 * Provides dashboard statistics aggregation from TimescaleDB.
 * Exposes internal endpoints protected by service-to-service authentication.
 */
@Module({
  imports: [TypeOrmModule.forFeature([RawEventEntity])],
  controllers: [StatsController],
  providers: [StatsService, StatsRepository, AppCategorizationService],
  exports: [StatsService],
})
export class StatsModule {}
