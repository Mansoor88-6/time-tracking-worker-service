import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TeamProductivityRule } from './entities/team-productivity-rule.entity';
import { TeamMember } from './entities/team-member.entity';
import { UnclassifiedApp } from './entities/unclassified-app.entity';
import { RuleCollection } from './entities/rule-collection.entity';
import { RuleCollectionTeam } from './entities/rule-collection-team.entity';

/**
 * Backend Database Module
 *
 * Configures TypeORM connection to the backend PostgreSQL database
 * for reading team productivity rules and user team memberships.
 * This is a read-only connection (recommended for worker service).
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: 'backend', // Named connection to avoid conflicts with TimescaleDB
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('backendDb.host'),
        port: configService.get<number>('backendDb.port'),
        username: configService.get<string>('backendDb.username'),
        password: configService.get<string>('backendDb.password'),
        database: configService.get<string>('backendDb.database'),
               entities: [TeamProductivityRule, TeamMember, UnclassifiedApp, RuleCollection, RuleCollectionTeam],
        synchronize: false, // Never synchronize - read-only access
        logging: process.env.NODE_ENV === 'development',
        // Connection pool settings
        extra: {
          max: 10, // Maximum pool size
          min: 2, // Minimum pool size
          idleTimeoutMillis: 30000,
        },
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature(
      [TeamProductivityRule, TeamMember, UnclassifiedApp, RuleCollection, RuleCollectionTeam],
      'backend',
    ),
  ],
  exports: [TypeOrmModule],
})
export class BackendDbModule {}
