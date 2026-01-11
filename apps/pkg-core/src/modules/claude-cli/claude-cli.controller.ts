import { Controller, Get, Query } from '@nestjs/common';
import { ClaudeCliService } from './claude-cli.service';

@Controller('claude-cli')
export class ClaudeCliController {
  constructor(private claudeCliService: ClaudeCliService) {}

  /**
   * Get Claude CLI usage statistics
   * GET /claude-cli/stats?period=month
   */
  @Get('stats')
  async getStats(
    @Query('period') period: 'day' | 'week' | 'month' = 'month',
  ) {
    return this.claudeCliService.getStats(period);
  }

  /**
   * Get daily Claude CLI statistics
   * GET /claude-cli/daily?days=30
   */
  @Get('daily')
  async getDailyStats(
    @Query('days') days = '30',
  ) {
    return this.claudeCliService.getDailyStats(parseInt(days, 10));
  }
}
