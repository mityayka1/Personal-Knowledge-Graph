import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClaudeAgentRun } from '@pkg/entities';
import { ClaudeAgentService } from './claude-agent.service';
import { ClaudeAgentController } from './claude-agent.controller';
import { SchemaLoaderService } from './schema-loader.service';
import { ToolsRegistryService } from './tools-registry.service';
import {
  SearchToolsProvider,
  EntityToolsProvider,
  EventToolsProvider,
  ContextToolsProvider,
} from './tools';
import { SearchModule } from '../search/search.module';
import { ContextModule } from '../context/context.module';
import { EntityEventModule } from '../entity-event/entity-event.module';
import { EntityModule } from '../entity/entity.module';

/**
 * Claude Agent Module
 *
 * Provides AI capabilities through Claude Agent SDK integration.
 *
 * Architecture:
 * - Tool providers are injected via DI (not factory functions)
 * - ContextToolsProvider uses @Optional injection to break circular dependency
 * - ContextModule must import ClaudeAgentModule (not the other way around)
 *   to make ContextService available for ContextToolsProvider
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ClaudeAgentRun]),
    SearchModule,
    // forwardRef is still needed because ContextModule imports ClaudeAgentModule
    // and we need ContextService for ContextToolsProvider
    forwardRef(() => ContextModule),
    EntityEventModule,
    EntityModule,
  ],
  controllers: [ClaudeAgentController],
  providers: [
    // Core services
    ClaudeAgentService,
    SchemaLoaderService,
    ToolsRegistryService,
    // Tool providers (NestJS Injectable)
    SearchToolsProvider,
    EntityToolsProvider,
    EventToolsProvider,
    ContextToolsProvider,
  ],
  exports: [
    ClaudeAgentService,
    SchemaLoaderService,
    ToolsRegistryService,
    // Export providers for potential external usage
    SearchToolsProvider,
    EntityToolsProvider,
    EventToolsProvider,
    ContextToolsProvider,
  ],
})
export class ClaudeAgentModule {}
