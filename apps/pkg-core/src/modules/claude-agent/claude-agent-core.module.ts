import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClaudeAgentRun } from '@pkg/entities';
import { ClaudeAgentService } from './claude-agent.service';
import { SchemaLoaderService } from './schema-loader.service';
import { ToolsRegistryService } from './tools-registry.service';
import { RecallSessionService } from './recall-session.service';

/**
 * ClaudeAgentCoreModule — чистые AI-сервисы без доменных зависимостей.
 *
 * Содержит:
 * - ClaudeAgentService — вызов Claude Agent SDK
 * - SchemaLoaderService — загрузка JSON Schema
 * - RecallSessionService — Redis session management
 * - ToolsRegistryService — реестр tool providers (registration pattern)
 *
 * Доменные модули импортируют этот модуль (вместо ClaudeAgentModule)
 * для доступа к ClaudeAgentService без создания циклических зависимостей.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ClaudeAgentRun]),
  ],
  providers: [
    ClaudeAgentService,
    SchemaLoaderService,
    ToolsRegistryService,
    RecallSessionService,
  ],
  exports: [
    ClaudeAgentService,
    SchemaLoaderService,
    ToolsRegistryService,
    RecallSessionService,
  ],
})
export class ClaudeAgentCoreModule {}
