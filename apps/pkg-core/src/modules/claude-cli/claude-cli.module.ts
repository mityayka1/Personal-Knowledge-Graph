import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClaudeCliRun } from '@pkg/entities';
import { ClaudeCliService } from './claude-cli.service';
import { ClaudeCliController } from './claude-cli.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([ClaudeCliRun]),
  ],
  controllers: [ClaudeCliController],
  providers: [ClaudeCliService],
  exports: [ClaudeCliService],
})
export class ClaudeCliModule {}
