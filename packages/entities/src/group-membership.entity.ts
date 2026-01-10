import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { EntityRecord } from './entity.entity';

@Entity('group_memberships')
@Index(['telegramChatId', 'telegramUserId'])
export class GroupMembership {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'telegram_chat_id', type: 'varchar', length: 100 })
  @Index()
  telegramChatId: string;

  @Column({ name: 'entity_id', type: 'uuid', nullable: true })
  entityId: string | null;

  @ManyToOne(() => EntityRecord, { nullable: true })
  @JoinColumn({ name: 'entity_id' })
  entity: EntityRecord | null;

  @Column({ name: 'telegram_user_id', type: 'varchar', length: 100 })
  @Index()
  telegramUserId: string;

  @Column({ name: 'display_name', type: 'varchar', length: 255, nullable: true })
  displayName: string | null;

  @Column({ name: 'joined_at', type: 'timestamp with time zone' })
  joinedAt: Date;

  @Column({ name: 'left_at', type: 'timestamp with time zone', nullable: true })
  leftAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  /**
   * Computed: is the member currently active in the group
   */
  get isActive(): boolean {
    return this.leftAt === null;
  }
}
