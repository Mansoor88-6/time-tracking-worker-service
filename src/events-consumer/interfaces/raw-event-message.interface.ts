/**
 * Raw Event Message Interface
 *
 * This interface defines the structure of messages consumed from the Kafka 'raw-events' topic.
 * It matches the payload structure published by the API's EventsService.
 *
 * Topic: raw-events
 * Producer: time-tracking-backend API (EventsService)
 * Consumer: time-tracking-worker-service (EventsConsumerService)
 */

export enum EventStatus {
  ACTIVE = 'active',
  IDLE = 'idle',
  AWAY = 'away',
  OFFLINE = 'offline',
}

export interface RawEvent {
  deviceId: string;
  timestamp: number; // Unix timestamp in milliseconds
  status: EventStatus;
  application?: string;
  title?: string;
  duration?: number; // milliseconds
  url?: string;
  projectId?: string;
  source?: 'browser' | 'app';
  tabId?: number;
  windowId?: number;
  sequence?: number;
  startTime?: number; // Unix timestamp in milliseconds
  endTime?: number; // Unix timestamp in milliseconds
  activeDuration?: number; // milliseconds
  idleDuration?: number; // milliseconds
}

export interface RawEventMessage {
  tenantId: number;
  userId: number;
  deviceId: string;
  batchTimestamp: number; // Unix timestamp in milliseconds
  events: RawEvent[];
  ingestedAt?: number; // Added by API when publishing
}
