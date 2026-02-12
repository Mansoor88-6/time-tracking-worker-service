import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  Unique,
} from 'typeorm';

@Entity('rule_collection_team')
@Index(['collectionId'])
@Index(['teamId'])
@Unique(['collectionId', 'teamId'])
export class RuleCollectionTeam {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'collectionId', type: 'integer' })
  collectionId: number;

  @Column({ name: 'teamId', type: 'integer' })
  teamId: number;

  @Column({ type: 'timestamp', name: 'createdAt' })
  createdAt: Date;
}
