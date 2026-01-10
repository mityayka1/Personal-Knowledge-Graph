import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { EntityRecord } from './entity.entity';

export enum IdentifierType {
  TELEGRAM_USER_ID = 'telegram_user_id',
  TELEGRAM_USERNAME = 'telegram_username',
  PHONE = 'phone',
  EMAIL = 'email',
  WHATSAPP = 'whatsapp',
}

@Entity('entity_identifiers')
@Unique(['identifierType', 'identifierValue'])
@Index(['identifierType', 'identifierValue'])
export class EntityIdentifier {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'entity_id', type: 'uuid' })
  entityId: string;

  @ManyToOne(() => EntityRecord, (entity) => entity.identifiers, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'entity_id' })
  entity: EntityRecord;

  @Column({ name: 'identifier_type', length: 50 })
  identifierType: IdentifierType | string;

  @Column({ name: 'identifier_value', length: 255 })
  identifierValue: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: {
    telegram_username?: string;
    display_name?: string;
    first_name?: string;
    last_name?: string;
    [key: string]: unknown;
  } | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
