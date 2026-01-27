import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RawEventEntity } from './entities/raw-event.entity';
import { RawEventsRepository } from './raw-events.repository';

/**
 * TimescaleDB Module
 *
 * Configures TypeORM connection to TimescaleDB for storing raw time-tracking events.
 * Uses a dedicated connection separate from the main application database.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('timescale.host'),
        port: configService.get<number>('timescale.port'),
        username: configService.get<string>('timescale.username'),
        password: configService.get<string>('timescale.password'),
        database: configService.get<string>('timescale.database'),
        entities: [RawEventEntity],
        synchronize: false, // Use migrations instead of synchronize in production
        logging: process.env.NODE_ENV === 'development',
        // Connection pool settings for high-throughput ingestion
        extra: {
          max: 20, // Maximum pool size
          min: 5, // Minimum pool size
          idleTimeoutMillis: 30000,
        },
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([RawEventEntity]),
  ],
  providers: [RawEventsRepository],
  exports: [RawEventsRepository],
})
export class TimescaleModule {}
