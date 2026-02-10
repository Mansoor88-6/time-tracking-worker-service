import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import configuration from './config/configuration';
import { KafkaModule } from './kafka/kafka.module';
import { EventsConsumerModule } from './events-consumer/events-consumer.module';
import { TimescaleModule } from './timescale/timescale.module';
import { HealthModule } from './health/health.module';
import { StatsModule } from './stats/stats.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    KafkaModule,
    TimescaleModule,
    EventsConsumerModule,
    HealthModule,
    StatsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
