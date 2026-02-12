import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  Unique,
} from 'typeorm';

@Entity('team_member')
@Index(['teamId'])
@Index(['userId'])
@Unique(['teamId', 'userId'])
export class TeamMember {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'integer', name: 'teamId' })
  teamId: number;

  @Column({ type: 'integer', name: 'userId' })
  userId: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  teamRole?: string | null;

  @Column({ type: 'timestamp', name: 'createdAt' })
  createdAt: Date;

  @Column({ type: 'timestamp', name: 'updatedAt' })
  updatedAt: Date;
}
