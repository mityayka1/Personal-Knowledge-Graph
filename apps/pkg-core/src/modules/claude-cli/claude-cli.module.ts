import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClaudeCliRun } from '@pkg/entities';
import { ClaudeCliService } from './claude-cli.service';
import { ClaudeCliController } from './claude-cli.controller';
import { SchemaLoaderService } from './schema-loader.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ClaudeCliRun]),
  ],
  controllers: [ClaudeCliController],
  providers: [ClaudeCliService, SchemaLoaderService],
  exports: [ClaudeCliService, SchemaLoaderService],
})
export class ClaudeCliModule {}
