import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';

@Entity('rule_collection')
@Index(['tenantId'])
export class RuleCollection {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({ name: 'tenantId', type: 'integer' })
  tenantId: number;

  @Column({ name: 'createdBy', nullable: true, type: 'integer' })
  createdBy?: number | null;

  @Column({ type: 'timestamp', name: 'createdAt' })
  createdAt: Date;

  @Column({ type: 'timestamp', name: 'updatedAt' })
  updatedAt: Date;
}
