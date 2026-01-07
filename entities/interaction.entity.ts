import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  OneToOne,
  Index,
} from 'typeorm';
import { InteractionParticipant } from './interaction-participant.entity';
import { Message } from './message.entity';
import { TranscriptSegment } from './transcript-segment.entity';
import { InteractionSummary } from './interaction-summary.entity';

export enum InteractionType {
  TELEGRAM_SESSION = 'telegram_session',
  PHONE_CALL = 'phone_call',
  VIDEO_MEETING = 'video_meeting',
}

export enum InteractionSource {
  TELEGRAM = 'telegram',
  MANUAL_UPLOAD = 'manual_upload',
  GOOGLE_MEET = 'google_meet',
  ZOOM = 'zoom',
}

export enum InteractionStatus {
  ACTIVE = 'active',
  COMPLETED = 'completed',
  PENDING_REVIEW = 'pending_review',
  PROCESSING = 'processing',
  ERROR = 'error',
}

@Entity('interactions')
@Index(['type', 'status'])
export class Interaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 50 })
  @Index()
  type: InteractionType;

  @Column({ length: 50 })
  source: InteractionSource | string;

  @Column({ length: 20, default: InteractionStatus.ACTIVE })
  @Index()
  status: InteractionStatus;

  @Column({ name: 'started_at', type: 'timestamp with time zone' })
  @Index()
  startedAt: Date;

  @Column({ name: 'ended_at', type: 'timestamp with time zone', nullable: true })
  endedAt: Date | null;

  @Column({ name: 'source_metadata', type: 'jsonb', nullable: true })
  sourceMetadata: {
    // Telegram
    telegram_chat_id?: string;
    chat_type?: 'private' | 'group' | 'supergroup';

    // Phone call
    phone_number?: string;
    direction?: 'incoming' | 'outgoing';
    duration_seconds?: number;
    audio_file_path?: string;

    // Video meeting
    meeting_url?: string;
    meeting_id?: string;
    platform?: string;

    [key: string]: unknown;
  } | null;

  @OneToMany(() => InteractionParticipant, (p) => p.interaction)
  participants: InteractionParticipant[];

  @OneToMany(() => Message, (message) => message.interaction)
  messages: Message[];

  @OneToMany(() => TranscriptSegment, (segment) => segment.interaction)
  transcriptSegments: TranscriptSegment[];

  @OneToOne(() => InteractionSummary, (summary) => summary.interaction)
  summary: InteractionSummary | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
