import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import {
  EntityRecord,
  EntityIdentifier,
  EntityFact,
  Interaction,
  InteractionParticipant,
  Message,
  TranscriptSegment,
  InteractionSummary,
  PendingEntityResolution,
  PendingFact,
  Job,
  Setting,
} from '@pkg/entities';

export default registerAs('database', (): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME || 'pkg',
  password: process.env.DB_PASSWORD || 'pkg_password',
  database: process.env.DB_DATABASE || 'pkg',

  // SSL
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,

  // Entities
  entities: [
    EntityRecord,
    EntityIdentifier,
    EntityFact,
    Interaction,
    InteractionParticipant,
    Message,
    TranscriptSegment,
    InteractionSummary,
    PendingEntityResolution,
    PendingFact,
    Job,
    Setting,
  ],

  // NEVER synchronize in production!
  synchronize: process.env.NODE_ENV === 'development',

  // Logging
  logging: process.env.NODE_ENV === 'development',

  // Auto-load entities (alternative to explicit list)
  autoLoadEntities: false,
}));
