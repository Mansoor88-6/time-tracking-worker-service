import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import {
  UnclassifiedApp,
  UnclassifiedAppStatus,
} from '../backend-db/entities/unclassified-app.entity';
import { AppType } from '../backend-db/entities/team-productivity-rule.entity';

/**
 * Unclassified Apps Tracker Service
 *
 * Tracks apps/domains that are not present in any team rules.
 * These are stored for admin review and classification.
 */
@Injectable()
export class UnclassifiedAppsTrackerService {
  private readonly logger = new Logger(UnclassifiedAppsTrackerService.name);

  constructor(
    @InjectRepository(UnclassifiedApp, 'backend')
    private readonly unclassifiedRepository: Repository<UnclassifiedApp>,
  ) {}

  /**
   * Track an unclassified app/domain
   * Upserts the record, updating lastSeen and incrementing eventCount
   */
  async trackUnclassifiedApp(
    tenantId: number,
    userId: number,
    teamId: number | null,
    appName: string,
    appType: AppType,
  ): Promise<void> {
    try {
      const normalizedAppName = appName.toLowerCase().trim();
      const now = new Date();

      // Find existing record
      const where: any = {
        tenantId,
        appName: normalizedAppName,
        appType,
      };
      if (teamId !== null) {
        where.teamId = teamId;
      } else {
        where.teamId = IsNull();
      }

      const existing = await this.unclassifiedRepository.findOne({
        where,
      });

      if (existing) {
        // Update existing record
        existing.lastSeen = now;
        existing.eventCount += 1;
        await this.unclassifiedRepository.save(existing);
      } else {
        // Create new record
        const unclassified = this.unclassifiedRepository.create({
          tenantId,
          teamId: teamId || null,
          appName: normalizedAppName,
          appType,
          firstSeen: now,
          lastSeen: now,
          eventCount: 1,
          status: UnclassifiedAppStatus.PENDING,
        });
        await this.unclassifiedRepository.save(unclassified);

        this.logger.debug(
          `Tracked new unclassified app: ${normalizedAppName} (${appType}) for tenant ${tenantId}`,
        );
      }
    } catch (error) {
      // Log error but don't throw - tracking failures shouldn't break categorization
      this.logger.error(
        `Failed to track unclassified app: ${appName}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Batch track multiple unclassified apps
   * More efficient for high-volume scenarios
   */
  async batchTrackUnclassifiedApps(
    records: Array<{
      tenantId: number;
      userId: number;
      teamId: number | null;
      appName: string;
      appType: AppType;
    }>,
  ): Promise<void> {
    try {
      const now = new Date();
      const upserts: Promise<void>[] = [];

      for (const record of records) {
        const normalizedAppName = record.appName.toLowerCase().trim();

        upserts.push(
          (async () => {
            const where: any = {
              tenantId: record.tenantId,
              appName: normalizedAppName,
              appType: record.appType,
            };
            if (record.teamId !== null) {
              where.teamId = record.teamId;
            } else {
              where.teamId = IsNull();
            }

            const existing = await this.unclassifiedRepository.findOne({
              where,
            });

            if (existing) {
              existing.lastSeen = now;
              existing.eventCount += 1;
              await this.unclassifiedRepository.save(existing);
            } else {
              const unclassified = this.unclassifiedRepository.create({
                tenantId: record.tenantId,
                teamId: record.teamId || null,
                appName: normalizedAppName,
                appType: record.appType,
                firstSeen: now,
                lastSeen: now,
                eventCount: 1,
                status: UnclassifiedAppStatus.PENDING,
              });
              await this.unclassifiedRepository.save(unclassified);
            }
          })(),
        );
      }

      await Promise.all(upserts);
    } catch (error) {
      this.logger.error(
        'Failed to batch track unclassified apps',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
