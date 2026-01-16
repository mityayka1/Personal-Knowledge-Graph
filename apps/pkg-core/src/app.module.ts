import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { RedisModule } from '@nestjs-modules/ioredis';

import { databaseConfig, redisConfig, appConfig } from './common/config';
import authConfig from './common/config/auth.config';
import { CombinedAuthGuard } from './common/guards/combined-auth.guard';

// Domain modules
import { EntityModule } from './modules/entity/entity.module';
import { InteractionModule } from './modules/interaction/interaction.module';
import { ResolutionModule } from './modules/resolution/resolution.module';
import { SearchModule } from './modules/search/search.module';
import { ContextModule } from './modules/context/context.module';
import { JobModule } from './modules/job/job.module';
import { EmbeddingModule } from './modules/embedding/embedding.module';
import { ExtractionModule } from './modules/extraction/extraction.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import { HealthModule } from './modules/health/health.module';
import { SettingsModule } from './modules/settings/settings.module';
import { ChatCategoryModule } from './modules/chat-category/chat-category.module';
import { GroupMembershipModule } from './modules/group-membership/group-membership.module';
import { EntityEventModule } from './modules/entity-event/entity-event.module';
import { ClaudeAgentModule } from './modules/claude-agent/claude-agent.module';
import { SummarizationModule } from './modules/summarization/summarization.module';
import { MediaModule } from './modules/media/media.module';
import { AuthModule } from './modules/auth/auth.module';
import { NotificationModule } from './modules/notification/notification.module';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, redisConfig, appConfig, authConfig],
      envFilePath: ['.env.local', '.env'],
    }),

    // Database (TypeORM + pgvector)
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        ...configService.get('database'),
      }),
    }),

    // Queue (BullMQ + Redis)
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisConfig = configService.get('redis');
        return {
          connection: redisConfig?.connection || {
            host: 'localhost',
            port: 6379,
          },
          prefix: redisConfig?.prefix || 'pkg:bull',
          defaultJobOptions: redisConfig?.defaultJobOptions || {},
        };
      },
    }),

    // Redis for session/token storage
    RedisModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisConf = configService.get('redis');
        return {
          type: 'single',
          url: `redis://${redisConf?.connection?.host || 'localhost'}:${redisConf?.connection?.port || 6379}`,
        };
      },
    }),

    // Rate limiting
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // 1 minute
        limit: 100, // 100 requests per minute
      },
    ]),

    // Auth module
    AuthModule,

    // Domain modules
    EntityModule,
    InteractionModule,
    ResolutionModule,
    SearchModule,
    ContextModule,
    JobModule,
    EmbeddingModule,
    ExtractionModule,
    WebhookModule,
    HealthModule,
    SettingsModule,
    ChatCategoryModule,
    GroupMembershipModule,
    EntityEventModule,
    ClaudeAgentModule,
    SummarizationModule,
    MediaModule,
    NotificationModule,
  ],
  providers: [
    // Global Combined Auth Guard - supports JWT and API Key
    // Use @Public() decorator to exclude specific routes (e.g., health checks, auth endpoints)
    {
      provide: APP_GUARD,
      useClass: CombinedAuthGuard,
    },
    // Global Throttler Guard for rate limiting
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
