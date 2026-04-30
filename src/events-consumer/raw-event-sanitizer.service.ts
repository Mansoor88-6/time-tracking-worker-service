import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildSystemIdleDenySet,
  sanitizeSystemIdleRawEvents,
} from './system-idle-raw-event.sanitizer';
import type { RawEvent } from './interfaces/raw-event-message.interface';

@Injectable()
export class RawEventSanitizerService {
  private denySet: Set<string>;

  constructor(private readonly configService: ConfigService) {
    const extra = this.configService.get<string>('worker.systemIdleAppDenylist');
    this.denySet = buildSystemIdleDenySet(extra);
  }

  sanitize(events: RawEvent[]): RawEvent[] {
    return sanitizeSystemIdleRawEvents(events, this.denySet);
  }
}
