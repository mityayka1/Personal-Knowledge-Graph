import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClaudeAgentRun } from '@pkg/entities';
import { ClaudeAgentService } from './claude-agent.service';
import { ClaudeAgentController } from './claude-agent.controller';
import { AgentController } from './agent.controller';
import { ActivityEnrichmentController } from './activity-enrichment.controller';
import { SchemaLoaderService } from './schema-loader.service';
import { ToolsRegistryService } from './tools-registry.service';
import { RecallSessionService } from './recall-session.service';
import {
  SearchToolsProvider,
  EntityToolsProvider,
  EventToolsProvider,
  ContextToolsProvider,
  ActionToolsProvider,
  ActivityToolsProvider,
  DataQualityToolsProvider,
} from './tools';
import { SearchModule } from '../search/search.module';
import { ContextModule } from '../context/context.module';
import { EntityEventModule } from '../entity-event/entity-event.module';
import { EntityModule } from '../entity/entity.module';
import { NotificationModule } from '../notification/notification.module';
import { ActivityModule } from '../activity/activity.module';
import { DataQualityModule } from '../data-quality/data-quality.module';
import { ExtractionModule } from '../extraction/extraction.module';

/**
 * Claude Agent Module
 *
 * Provides AI capabilities through Claude Agent SDK integration.
 *
 * Architecture:
 * - Tool providers are injected via DI (not factory functions)
 * - ContextToolsProvider uses @Optional + forwardRef to handle bidirectional module imports
 *
 * Module Import Graph:
 *   ContextModule → ClaudeAgentModule (uses ClaudeAgentService for context generation)
 *   ClaudeAgentModule → ContextModule (ContextToolsProvider needs ContextService)
 *
 * Resolution:
 * - forwardRef() on ClaudeAgentModule side when importing ContextModule
 * - @Optional() + forwardRef() in ContextToolsProvider for ContextService injection
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ClaudeAgentRun]),
    SearchModule,
    // Bidirectional import with ContextModule:
    // ContextModule imports ClaudeAgentModule, so we use forwardRef here
    forwardRef(() => ContextModule),
    EntityEventModule,
    forwardRef(() => EntityModule),
    // NotificationModule for ApprovalService (action tools)
    forwardRef(() => NotificationModule),
    // ActivityModule for ActivityToolsProvider
    forwardRef(() => ActivityModule),
    // DataQualityModule for DataQualityToolsProvider
    forwardRef(() => DataQualityModule),
    // ExtractionModule for DailySynthesisExtractionService
    forwardRef(() => ExtractionModule),
  ],
  controllers: [ClaudeAgentController, AgentController, ActivityEnrichmentController],
  providers: [
    // Core services
    ClaudeAgentService,
    SchemaLoaderService,
    ToolsRegistryService,
    RecallSessionService,
    // Tool providers (NestJS Injectable)
    SearchToolsProvider,
    EntityToolsProvider,
    EventToolsProvider,
    ContextToolsProvider,
    ActionToolsProvider,
    ActivityToolsProvider,
    DataQualityToolsProvider,
  ],
  exports: [
    ClaudeAgentService,
    SchemaLoaderService,
    ToolsRegistryService,
    RecallSessionService,
    // Export providers for potential external usage
    SearchToolsProvider,
    EntityToolsProvider,
    EventToolsProvider,
    ContextToolsProvider,
    ActionToolsProvider,
    ActivityToolsProvider,
    DataQualityToolsProvider,
  ],
})
export class ClaudeAgentModule {}
