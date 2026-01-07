import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { Interaction } from './interaction.entity';
import { EntityRecord } from './entity.entity';

export enum ParticipantRole {
  SELF = 'self',
  PARTICIPANT = 'participant',
  INITIATOR = 'initiator',
}

@Entity('interaction_participants')
@Unique(['interactionId', 'identifierType', 'identifierValue'])
export class InteractionParticipant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'interaction_id', type: 'uuid' })
  interactionId: string;

  @ManyToOne(() => Interaction, (interaction) => interaction.participants, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'interaction_id' })
  interaction: Interaction;

  @Column({ name: 'entity_id', type: 'uuid', nullable: true })
  entityId: string | null;

  @ManyToOne(() => EntityRecord, (entity) => entity.participations, {
    nullable: true,
  })
  @JoinColumn({ name: 'entity_id' })
  entity: EntityRecord | null;

  @Column({ length: 50, default: ParticipantRole.PARTICIPANT })
  role: ParticipantRole;

  @Column({ name: 'identifier_type', length: 50 })
  identifierType: string;

  @Column({ name: 'identifier_value', length: 255 })
  identifierValue: string;

  @Column({ name: 'display_name', type: 'varchar', length: 255, nullable: true })
  displayName: string | null;
}
