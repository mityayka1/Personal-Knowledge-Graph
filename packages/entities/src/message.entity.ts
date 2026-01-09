import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Interaction } from './interaction.entity';
import { EntityRecord } from './entity.entity';

export enum MediaType {
  PHOTO = 'photo',
  DOCUMENT = 'document',
  VOICE = 'voice',
  VIDEO = 'video',
  VIDEO_NOTE = 'video_note',
  STICKER = 'sticker',
  ANIMATION = 'animation',
}

export enum ChatType {
  PRIVATE = 'private',
  GROUP = 'group',
  SUPERGROUP = 'supergroup',
  CHANNEL = 'channel',
  FORUM = 'forum',
}

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'interaction_id', type: 'uuid' })
  @Index()
  interactionId: string;

  @ManyToOne(() => Interaction, (interaction) => interaction.messages, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'interaction_id' })
  interaction: Interaction;

  @Column({ name: 'sender_entity_id', type: 'uuid', nullable: true })
  @Index()
  senderEntityId: string | null;

  @ManyToOne(() => EntityRecord, { nullable: true })
  @JoinColumn({ name: 'sender_entity_id' })
  senderEntity: EntityRecord | null;

  // Identifier of the sender (e.g., telegram_user_id) - for proper message attribution
  @Column({ name: 'sender_identifier_type', type: 'varchar', length: 50, nullable: true })
  senderIdentifierType: string | null;

  @Column({ name: 'sender_identifier_value', type: 'varchar', length: 255, nullable: true })
  @Index()
  senderIdentifierValue: string | null;

  @Column({ type: 'text', nullable: true })
  content: string | null;

  @Column({ name: 'is_outgoing', type: 'boolean', default: false })
  isOutgoing: boolean;

  @Column({ type: 'timestamp with time zone' })
  @Index()
  timestamp: Date;

  @Column({ name: 'source_message_id', type: 'varchar', length: 100, nullable: true })
  sourceMessageId: string | null;

  @Column({ name: 'reply_to_message_id', type: 'uuid', nullable: true })
  replyToMessageId: string | null;

  @ManyToOne(() => Message, { nullable: true })
  @JoinColumn({ name: 'reply_to_message_id' })
  replyToMessage: Message | null;

  @Column({ name: 'media_type', type: 'varchar', length: 50, nullable: true })
  mediaType: MediaType | null;

  @Column({ name: 'media_url', type: 'varchar', length: 500, nullable: true })
  mediaUrl: string | null;

  // Chat type for import logic (private chats get auto-entity creation)
  @Column({ name: 'chat_type', type: 'varchar', length: 20, nullable: true })
  chatType: ChatType | null;

  // Forum topic support
  @Column({ name: 'topic_id', type: 'integer', nullable: true })
  @Index()
  topicId: number | null;

  @Column({ name: 'topic_name', type: 'varchar', length: 255, nullable: true })
  topicName: string | null;

  // pgvector column - 1536 dimensions for OpenAI text-embedding-3-small
  // Note: Vector index should be created manually: CREATE INDEX ON messages USING ivfflat (embedding vector_cosine_ops)
  @Column({ type: 'vector', length: 1536, nullable: true })
  embedding: number[] | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
