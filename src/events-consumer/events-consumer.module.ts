import { Module } from '@nestjs/common';
import { EventsConsumerService } from './events-consumer.service';
import { RawEventSanitizerService } from './raw-event-sanitizer.service';
import { TimescaleModule } from '../timescale/timescale.module';

/**
 * Events Consumer Module
 *
 * Handles consumption of raw events from Kafka and persistence to TimescaleDB.
 */
@Module({
  imports: [TimescaleModule],
  controllers: [EventsConsumerService], // Must be a controller for @EventPattern to work
  providers: [RawEventSanitizerService],
})
export class EventsConsumerModule {}
