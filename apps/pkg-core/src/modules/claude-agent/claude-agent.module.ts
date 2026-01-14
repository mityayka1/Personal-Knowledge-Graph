import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClaudeAgentRun } from '@pkg/entities';
import { ClaudeAgentService } from './claude-agent.service';
import { ClaudeAgentController } from './claude-agent.controller';
import { SchemaLoaderService } from './schema-loader.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ClaudeAgentRun]),
  ],
  controllers: [ClaudeAgentController],
  providers: [ClaudeAgentService, SchemaLoaderService],
  exports: [ClaudeAgentService, SchemaLoaderService],
})
export class ClaudeAgentModule {}
