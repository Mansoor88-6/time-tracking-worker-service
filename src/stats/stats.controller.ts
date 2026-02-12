import { Controller, Get, Query, UseGuards, Logger } from '@nestjs/common';
import { StatsService } from './stats.service';
import { StatsQueryDto } from './dto/stats-query.dto';
import { InternalKeyGuard } from './guards/internal-key.guard';

/**
 * Stats Controller
 *
 * Provides internal HTTP endpoints for dashboard statistics.
 * Protected by InternalKeyGuard for service-to-service communication.
 */
@Controller('internal/stats')
@UseGuards(InternalKeyGuard)
export class StatsController {
  private readonly logger = new Logger(StatsController.name);

  constructor(private readonly statsService: StatsService) {}

  @Get('summary')
  async getSummary(@Query() query: StatsQueryDto) {
    const startTime = Date.now();

    this.logger.log(
      `📊 Stats request: tenant=${query.tenantId}, user=${query.userId}, date=${query.date || 'N/A'}, startDate=${query.startDate || 'N/A'}, endDate=${query.endDate || 'N/A'}, tz=${query.tz || 'UTC'}`,
    );

    try {
      const stats = await this.statsService.getDashboardStats(
        query.tenantId,
        query.userId,
        query.date,
        query.tz,
        query.startDate,
        query.endDate,
      );

      const duration = Date.now() - startTime;
      this.logger.log(
        `✅ Stats response in ${duration}ms for tenant ${query.tenantId}, user ${query.userId}`,
      );

      return stats;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `❌ Stats request failed after ${duration}ms: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  @Get('clear-cache')
  async clearCache(@Query() query: StatsQueryDto) {
    // clearCache requires a date - use today's date if not provided
    const date = query.date || this.getTodayDateString();
    this.statsService.clearCache(
      query.tenantId,
      query.userId,
      date,
      query.tz,
    );
    this.logger.log(
      `🗑️ Cache cleared for tenant=${query.tenantId}, user=${query.userId}, date=${date}, tz=${query.tz || 'UTC'}`,
    );
    return { message: 'Cache cleared successfully' };
  }

  private getTodayDateString(): string {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  @Get('app-usage')
  async getAppUsage(@Query() query: StatsQueryDto) {
    const startTime = Date.now();

    // Use today's date if not provided
    const date = query.date || this.getTodayDateString();

    this.logger.log(
      `📱 App usage request: tenant=${query.tenantId}, user=${query.userId}, date=${date}, tz=${query.tz || 'UTC'}`,
    );

    try {
      const appUsage = await this.statsService.getAppUsageStats(
        query.tenantId,
        query.userId,
        date,
        query.tz,
      );

      const duration = Date.now() - startTime;
      this.logger.log(
        `✅ App usage response in ${duration}ms for tenant ${query.tenantId}, user ${query.userId}`,
      );

      return appUsage;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `❌ App usage request failed after ${duration}ms: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }
}
