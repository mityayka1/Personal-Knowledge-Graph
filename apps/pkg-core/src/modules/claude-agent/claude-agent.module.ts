import { Module } from '@nestjs/common';
import { ClaudeAgentCoreModule } from './claude-agent-core.module';
import { ClaudeAgentController } from './claude-agent.controller';
import { AgentController } from './agent.controller';
import { ActivityEnrichmentController } from './activity-enrichment.controller';
import { SearchToolsProvider, EventToolsProvider } from './tools';
import { SearchModule } from '../search/search.module';
import { EntityEventModule } from '../entity-event/entity-event.module';
import { EntityModule } from '../entity/entity.module';
import { ExtractionModule } from '../extraction/extraction.module';
import { ActivityModule } from '../activity/activity.module';

/**
 * Claude Agent Module
 *
 * Provides AI-related controllers and remaining tool providers
 * that don't create circular dependencies.
 *
 * Architecture:
 * - Core AI services (ClaudeAgentService, ToolsRegistryService, etc.) are in ClaudeAgentCoreModule
 * - Domain-specific tool providers live in their domain modules and self-register via OnModuleInit
 * - This module hosts only controllers and tool providers for modules that don't create cycles
 *   (SearchModule, EntityEventModule)
 *
 * Domain module imports (EntityModule, ExtractionModule, ActivityModule) are
 * one-directional — those modules import ClaudeAgentCoreModule, NOT this module.
 */
@Module({
  imports: [
    ClaudeAgentCoreModule,
    SearchModule,
    EntityEventModule,
    // Domain modules for controllers (one-directional, no cycles)
    EntityModule,
    ExtractionModule,
    ActivityModule,
  ],
  controllers: [ClaudeAgentController, AgentController, ActivityEnrichmentController],
  providers: [
    // Only tool providers whose domain modules don't create cycles
    SearchToolsProvider,
    EventToolsProvider,
  ],
  exports: [ClaudeAgentCoreModule],
})
export class ClaudeAgentModule {}
