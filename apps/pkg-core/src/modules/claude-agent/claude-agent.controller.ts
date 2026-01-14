import { Controller, Get, Query } from '@nestjs/common';
import { ClaudeAgentService } from './claude-agent.service';

@Controller('claude-agent')
export class ClaudeAgentController {
  constructor(private claudeAgentService: ClaudeAgentService) {}

  /**
   * Get Claude Agent usage statistics
   * GET /claude-agent/stats?period=month
   */
  @Get('stats')
  async getStats(
    @Query('period') period: 'day' | 'week' | 'month' = 'month',
  ) {
    return this.claudeAgentService.getStats(period);
  }

  /**
   * Get daily Claude Agent statistics
   * GET /claude-agent/daily?days=30
   */
  @Get('daily')
  async getDailyStats(
    @Query('days') days = '30',
  ) {
    return this.claudeAgentService.getDailyStats(parseInt(days, 10));
  }
}
