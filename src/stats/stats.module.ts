import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';
import { StatsRepository } from './stats.repository';
import { AppCategorizationService } from './app-categorization.service';
import { RawEventEntity } from '../timescale/entities/raw-event.entity';
import { BackendDbModule } from '../backend-db/backend-db.module';
import { ProductivityRulesModule } from '../productivity-rules/productivity-rules.module';
import { TeamProductivityRule } from '../backend-db/entities/team-productivity-rule.entity';
import { TeamMember } from '../backend-db/entities/team-member.entity';
import { RuleCollectionTeam } from '../backend-db/entities/rule-collection-team.entity';
import { URLParserService } from './url-parser.service';

/**
 * Stats Module
 *
 * Provides dashboard statistics aggregation from TimescaleDB.
 * Exposes internal endpoints protected by service-to-service authentication.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([RawEventEntity]),
    BackendDbModule,
    ProductivityRulesModule,
    TypeOrmModule.forFeature([TeamProductivityRule, TeamMember, RuleCollectionTeam], 'backend'),
  ],
  controllers: [StatsController],
  providers: [StatsService, StatsRepository, AppCategorizationService, URLParserService],
  exports: [StatsService],
})
export class StatsModule {}
