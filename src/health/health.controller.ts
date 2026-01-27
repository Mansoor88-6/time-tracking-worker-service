import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Logger } from '@nestjs/common';
import { RawEventEntity } from '../timescale/entities/raw-event.entity';

/**
 * Health Check Controller
 *
 * Provides HTTP endpoints for monitoring worker service health.
 * Useful for container orchestration (Kubernetes liveness/readiness probes)
 * and monitoring systems.
 *
 * Note: This requires the worker to also run an HTTP server.
 * In a pure microservice setup, you might use a separate monitoring service instead.
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(RawEventEntity)
    private readonly rawEventRepository: Repository<RawEventEntity>,
  ) {}

  @Get()
  async checkHealth(): Promise<{
    status: string;
    timestamp: number;
    kafka: {
      broker: string;
      topic: string;
      consumerGroup: string;
    };
    timescale: {
      connected: boolean;
      host: string;
      port: number;
      database: string;
    };
  }> {
    const broker = this.configService.get<string>('kafka.broker') || 'unknown';
    const topic = this.configService.get<string>('kafka.topicRawEvents') || 'unknown';
    const consumerGroup = this.configService.get<string>('kafka.groupId') || 'unknown';
    const timescaleHost = this.configService.get<string>('timescale.host') || 'unknown';
    const timescalePort = this.configService.get<number>('timescale.port') || 5432;
    const timescaleDatabase = this.configService.get<string>(
      'timescale.database',
    ) || 'unknown';

    let timescaleConnected = false;
    try {
      // Check TimescaleDB connection by querying the repository
      await this.rawEventRepository.query('SELECT 1');
      timescaleConnected = true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`TimescaleDB health check failed: ${errorMessage}`);
      timescaleConnected = false;
    }

    const status = timescaleConnected ? 'healthy' : 'degraded';

    return {
      status,
      timestamp: Date.now(),
      kafka: {
        broker,
        topic,
        consumerGroup,
      },
      timescale: {
        connected: timescaleConnected,
        host: timescaleHost,
        port: timescalePort,
        database: timescaleDatabase,
      },
    };
  }

  @Get('liveness')
  liveness(): { status: string; timestamp: number } {
    // Simple liveness check - service is running
    return {
      status: 'alive',
      timestamp: Date.now(),
    };
  }

  @Get('readiness')
  async readiness(): Promise<{
    status: string;
    timestamp: number;
    ready: boolean;
  }> {
    // Readiness check - service is ready to process messages
    let ready = false;
    try {
      await this.rawEventRepository.query('SELECT 1');
      ready = true;
    } catch (error) {
      ready = false;
    }

    return {
      status: ready ? 'ready' : 'not ready',
      timestamp: Date.now(),
      ready,
    };
  }
}
