import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { SyncType, SyncStatus } from '../common/enums';

@Entity('sync_logs')
export class SyncLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  syncType: SyncType;

  @Column({ type: 'text' })
  status: SyncStatus;

  @Column({ type: 'integer', default: 0 })
  recordsProcessed: number;

  @Column({ type: 'integer', default: 0 })
  recordsUpdated: number;

  @Column({ type: 'text', nullable: true })
  errors: string | null;

  @CreateDateColumn()
  startedAt: Date;

  @Column({ type: 'datetime', nullable: true })
  completedAt: Date | null;
}
