import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';

import { databaseConfig, redisConfig, appConfig } from './common/config';

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

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, redisConfig, appConfig],
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
          prefix: redisConfig?.prefix || 'bull',
          defaultJobOptions: redisConfig?.defaultJobOptions || {},
        };
      },
    }),

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
  ],
})
export class AppModule {}
