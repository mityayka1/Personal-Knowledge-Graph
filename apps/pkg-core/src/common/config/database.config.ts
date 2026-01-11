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
  ChatCategoryRecord,
  GroupMembership,
  EntityEvent,
  EntityRelationshipProfile,
  ClaudeCliRun,
} from '@pkg/entities';

export default registerAs('database', (): TypeOrmModuleOptions => {
  const isRemoteDb = process.env.DB_HOST && process.env.DB_HOST !== 'localhost';

  // Warn in development if using remote DB
  if (process.env.NODE_ENV === 'development' && isRemoteDb) {
    console.warn('⚠️  Using remote database - be careful with data modifications');
  }

  return {
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME || 'pkg',
    password: process.env.DB_PASSWORD || 'pkg_password',
    database: process.env.DB_DATABASE || 'pkg',

    // SSL - enabled by default for remote connections (DB_SSL !== 'false')
    ssl:
      process.env.DB_SSL === 'false'
        ? false
        : isRemoteDb
          ? { rejectUnauthorized: process.env.DB_SSL_VERIFY !== 'false' }
          : false,

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
      ChatCategoryRecord,
      GroupMembership,
      EntityEvent,
      EntityRelationshipProfile,
      ClaudeCliRun,
    ],

    // Synchronize only for tests (creates tables automatically)
    // NEVER use synchronize in production!
    synchronize: process.env.NODE_ENV === 'test',

    // Connection retry for remote database
    retryAttempts: isRemoteDb ? 10 : 3,
    retryDelay: 3000,

    // Logging
    logging: process.env.NODE_ENV === 'development',

    // Auto-load entities (alternative to explicit list)
    autoLoadEntities: false,

    // Connection pool settings for remote DB
    extra: isRemoteDb
      ? {
          max: parseInt(process.env.DB_POOL_SIZE || '10', 10),
          connectionTimeoutMillis: 10000,
          idleTimeoutMillis: 30000,
        }
      : undefined,
  };
});
