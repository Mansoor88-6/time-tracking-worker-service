import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnclassifiedAppsTrackerService } from './unclassified-apps-tracker.service';
import { UnclassifiedApp } from '../backend-db/entities/unclassified-app.entity';
import { BackendDbModule } from '../backend-db/backend-db.module';

/**
 * Productivity Rules Module
 *
 * Handles tracking of unclassified apps/domains.
 */
@Module({
  imports: [
    BackendDbModule,
    TypeOrmModule.forFeature([UnclassifiedApp], 'backend'),
  ],
  providers: [UnclassifiedAppsTrackerService],
  exports: [UnclassifiedAppsTrackerService],
})
export class ProductivityRulesModule {}
