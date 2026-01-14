import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClaudeAgentRun } from '@pkg/entities';
import { ClaudeAgentService } from './claude-agent.service';
import { ClaudeAgentController } from './claude-agent.controller';
import { SchemaLoaderService } from './schema-loader.service';
import { ToolsRegistryService } from './tools-registry.service';
import { SearchModule } from '../search/search.module';
import { ContextModule } from '../context/context.module';
import { EntityEventModule } from '../entity-event/entity-event.module';
import { EntityModule } from '../entity/entity.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ClaudeAgentRun]),
    SearchModule,
    forwardRef(() => ContextModule),
    EntityEventModule,
    EntityModule,
  ],
  controllers: [ClaudeAgentController],
  providers: [ClaudeAgentService, SchemaLoaderService, ToolsRegistryService],
  exports: [ClaudeAgentService, SchemaLoaderService, ToolsRegistryService],
})
export class ClaudeAgentModule {}
