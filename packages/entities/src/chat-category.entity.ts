import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum ChatCategory {
  PERSONAL = 'personal',
  WORKING = 'working',
  MASS = 'mass',
}

@Entity('chat_categories')
export class ChatCategoryRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'telegram_chat_id', type: 'varchar', length: 100, unique: true })
  @Index()
  telegramChatId: string;

  @Column({ type: 'varchar', length: 20, default: ChatCategory.MASS })
  category: ChatCategory;

  @Column({ name: 'participants_count', type: 'integer', nullable: true })
  participantsCount: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title: string | null;

  @Column({ name: 'is_forum', type: 'boolean', default: false })
  isForum: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  /**
   * Computed: auto extraction enabled for personal and working categories
   */
  get autoExtractionEnabled(): boolean {
    return this.category === ChatCategory.PERSONAL || this.category === ChatCategory.WORKING;
  }
}
