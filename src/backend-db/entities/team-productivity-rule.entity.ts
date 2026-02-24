import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  Unique,
} from 'typeorm';

export enum AppType {
  DESKTOP = 'desktop',
  WEB = 'web',
}

export enum AppCategory {
  PRODUCTIVE = 'productive',
  UNPRODUCTIVE = 'unproductive',
  NEUTRAL = 'neutral',
}

export enum RuleType {
  APP_NAME = 'app_name',      // Legacy: matches by app name
  DOMAIN = 'domain',           // Matches entire domain
  URL_EXACT = 'url_exact',     // Exact URL match
  URL_PATTERN = 'url_pattern', // Pattern match (wildcards)
}

@Entity('team_productivity_rule')
@Index(['teamId'])
@Index(['teamId', 'appType'])
@Index(['collectionId'])
@Index(['ruleType'])
@Unique(['teamId', 'appName', 'appType'])
export class TeamProductivityRule {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer', name: 'teamId' })
  teamId: number;

  @Column({ type: 'integer', name: 'collectionId', nullable: true })
  collectionId?: number | null;

  @Column({ type: 'varchar', length: 255 })
  appName: string;

  @Column({
    type: 'enum',
    enum: AppType,
  })
  appType: AppType;

  @Column({
    type: 'enum',
    enum: AppCategory,
  })
  category: AppCategory;

  @Column({
    type: 'enum',
    enum: RuleType,
    default: RuleType.APP_NAME,
  })
  ruleType: RuleType;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'pattern' })
  pattern?: string; // For URL patterns, e.g., "github.com/*/issues"

  @Column({ type: 'timestamp', name: 'createdAt' })
  createdAt: Date;

  @Column({ type: 'timestamp', name: 'updatedAt' })
  updatedAt: Date;
}
