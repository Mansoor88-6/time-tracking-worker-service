import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  Unique,
} from 'typeorm';
import { AppType } from './team-productivity-rule.entity';

export enum UnclassifiedAppStatus {
  PENDING = 'pending',
  REVIEWED = 'reviewed',
  CLASSIFIED = 'classified',
}

@Entity('unclassified_app')
@Index(['tenantId'])
@Index(['tenantId', 'status'])
@Index(['teamId', 'status'])
@Unique(['tenantId', 'teamId', 'appName', 'appType'])
export class UnclassifiedApp {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer', name: 'tenantId' })
  tenantId: number;

  @Column({ type: 'integer', name: 'teamId', nullable: true })
  teamId?: number | null;

  @Column({ type: 'varchar', length: 255 })
  appName: string;

  @Column({
    type: 'enum',
    enum: AppType,
  })
  appType: AppType;

  @Column({ type: 'timestamp' })
  firstSeen: Date;

  @Column({ type: 'timestamp' })
  lastSeen: Date;

  @Column({ type: 'integer', default: 1 })
  eventCount: number;

  @Column({
    type: 'enum',
    enum: UnclassifiedAppStatus,
    default: UnclassifiedAppStatus.PENDING,
  })
  status: UnclassifiedAppStatus;

  @Column({ type: 'timestamp', name: 'createdAt' })
  createdAt: Date;

  @Column({ type: 'timestamp', name: 'updatedAt' })
  updatedAt: Date;
}
