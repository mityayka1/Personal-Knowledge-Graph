import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as path from 'path';
import { ClaudeCliRun, ClaudeTaskType, ReferenceType } from '@pkg/entities';

export interface ClaudeCliCallParams<T = unknown> {
  taskType: ClaudeTaskType;
  agentName?: string;
  prompt: string;
  schema: object;
  model?: 'sonnet' | 'haiku' | 'opus';
  referenceType?: ReferenceType;
  referenceId?: string;
  timeout?: number;
}

export interface ClaudeCliResult<T> {
  data: T;
  run: ClaudeCliRun;
}

interface ClaudeCliResponse {
  data: unknown;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  total_cost_usd?: number;
}

@Injectable()
export class ClaudeCliService {
  private readonly logger = new Logger(ClaudeCliService.name);
  private readonly claudePath: string;
  private readonly workspacePath: string;

  constructor(
    private configService: ConfigService,
    @InjectRepository(ClaudeCliRun)
    private runRepo: Repository<ClaudeCliRun>,
  ) {
    this.claudePath = configService.get<string>('CLAUDE_CLI_PATH') || 'claude';
    this.workspacePath = configService.get<string>('CLAUDE_WORKSPACE_PATH') ||
      path.join(process.cwd(), '..', '..', 'claude-workspace');
  }

  /**
   * Call Claude CLI with structured output
   */
  async call<T>(params: ClaudeCliCallParams<T>): Promise<ClaudeCliResult<T>> {
    const startTime = Date.now();
    const model = params.model || 'sonnet';
    const timeout = params.timeout || 120000; // 2 minutes default

    const args = [
      '--print',
      '--model', model,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(params.schema),
      '-p', params.prompt,
    ];

    this.logger.debug(`Calling Claude CLI: task=${params.taskType}, model=${model}`);

    let run: ClaudeCliRun;
    try {
      const result = await this.executeCommand(args, timeout);
      const durationMs = Date.now() - startTime;

      run = this.runRepo.create({
        taskType: params.taskType,
        model: `claude-3-5-${model}`,
        agentName: params.agentName || null,
        tokensIn: result.usage?.input_tokens || null,
        tokensOut: result.usage?.output_tokens || null,
        costUsd: result.total_cost_usd || null,
        durationMs,
        success: true,
        referenceType: params.referenceType || null,
        referenceId: params.referenceId || null,
        inputPreview: params.prompt.slice(0, 500),
        outputPreview: JSON.stringify(result.data).slice(0, 500),
        createdDate: new Date(),
      });
      await this.runRepo.save(run);

      this.logger.log(
        `Claude CLI success: task=${params.taskType}, duration=${durationMs}ms, ` +
        `tokens=${result.usage?.input_tokens || '?'}/${result.usage?.output_tokens || '?'}`
      );

      return { data: result.data as T, run };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      run = this.runRepo.create({
        taskType: params.taskType,
        model: `claude-3-5-${model}`,
        agentName: params.agentName || null,
        durationMs,
        success: false,
        errorMessage,
        referenceType: params.referenceType || null,
        referenceId: params.referenceId || null,
        inputPreview: params.prompt.slice(0, 500),
        createdDate: new Date(),
      });
      await this.runRepo.save(run);

      this.logger.error(`Claude CLI error: task=${params.taskType}, error=${errorMessage}`);
      throw error;
    }
  }

  /**
   * Execute Claude CLI command
   */
  private executeCommand(args: string[], timeout: number): Promise<ClaudeCliResponse> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.claudePath, args, {
        cwd: this.workspacePath,
        stdio: ['ignore', 'pipe', 'pipe'], // CRITICAL: stdin='ignore' prevents hanging
        env: process.env,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        reject(new Error(`Claude CLI timeout after ${timeout}ms`));
      }, timeout);

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timeoutId);

        if (timedOut) return;

        if (code !== 0) {
          reject(new Error(`Claude CLI failed with code ${code}: ${stderr}`));
          return;
        }

        try {
          const response = this.parseResponse(stdout);
          resolve(response);
        } catch (e) {
          reject(new Error(`Parse error: ${e instanceof Error ? e.message : e}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutId);
        reject(new Error(`Claude CLI spawn error: ${err.message}`));
      });
    });
  }

  /**
   * Parse Claude CLI JSON response
   */
  private parseResponse(jsonText: string): ClaudeCliResponse {
    const data = JSON.parse(jsonText);

    // Response is JSON array with --print flag
    if (Array.isArray(data)) {
      const resultMsg = data.find((m: { type: string }) => m.type === 'result');
      if (resultMsg) {
        return {
          // structured_output is the preferred source
          data: resultMsg.structured_output || this.parseFromText(resultMsg.result),
          usage: resultMsg.usage,
          total_cost_usd: resultMsg.total_cost_usd,
        };
      }
      throw new Error('No result message in response array');
    }

    // Direct object response (headless mode without --print)
    if (data.structured_output) {
      return {
        data: data.structured_output,
        usage: data.usage,
        total_cost_usd: data.total_cost_usd,
      };
    }

    throw new Error('Invalid response format: no structured_output found');
  }

  /**
   * Fallback: parse JSON from markdown code block in text
   */
  private parseFromText(text: string): unknown {
    if (!text) return null;

    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch?.[1]) {
      return JSON.parse(jsonMatch[1].trim());
    }

    // Try parsing the whole text as JSON
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * Get usage statistics for a period
   */
  async getStats(period: 'day' | 'week' | 'month' = 'month'): Promise<{
    period: string;
    startDate: Date;
    byTaskType: Array<{
      taskType: string;
      totalRuns: number;
      successfulRuns: number;
      totalTokensIn: number;
      totalTokensOut: number;
      totalCostUsd: number;
      avgDurationMs: number;
    }>;
    totals: {
      totalRuns: number;
      totalCostUsd: number;
    };
  }> {
    const startDate = this.getStartDate(period);

    const stats = await this.runRepo
      .createQueryBuilder('r')
      .select([
        'r.task_type as "taskType"',
        'COUNT(*)::int as "totalRuns"',
        'SUM(CASE WHEN r.success THEN 1 ELSE 0 END)::int as "successfulRuns"',
        'COALESCE(SUM(r.tokens_in), 0)::int as "totalTokensIn"',
        'COALESCE(SUM(r.tokens_out), 0)::int as "totalTokensOut"',
        'COALESCE(SUM(r.cost_usd), 0)::numeric as "totalCostUsd"',
        'COALESCE(AVG(r.duration_ms), 0)::int as "avgDurationMs"',
      ])
      .where('r.created_at >= :startDate', { startDate })
      .groupBy('r.task_type')
      .getRawMany();

    const totals = await this.runRepo
      .createQueryBuilder('r')
      .select([
        'COUNT(*)::int as "totalRuns"',
        'COALESCE(SUM(r.cost_usd), 0)::numeric as "totalCostUsd"',
      ])
      .where('r.created_at >= :startDate', { startDate })
      .getRawOne();

    return {
      period,
      startDate,
      byTaskType: stats,
      totals: totals || { totalRuns: 0, totalCostUsd: 0 },
    };
  }

  /**
   * Get daily statistics
   */
  async getDailyStats(days = 30): Promise<Array<{
    date: string;
    runs: number;
    costUsd: number;
  }>> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return this.runRepo
      .createQueryBuilder('r')
      .select([
        'r.created_date::text as "date"',
        'COUNT(*)::int as "runs"',
        'COALESCE(SUM(r.cost_usd), 0)::numeric as "costUsd"',
      ])
      .where('r.created_date >= :startDate', { startDate })
      .groupBy('r.created_date')
      .orderBy('r.created_date', 'ASC')
      .getRawMany();
  }

  private getStartDate(period: 'day' | 'week' | 'month'): Date {
    const now = new Date();
    switch (period) {
      case 'day':
        return new Date(now.setDate(now.getDate() - 1));
      case 'week':
        return new Date(now.setDate(now.getDate() - 7));
      case 'month':
      default:
        return new Date(now.setMonth(now.getMonth() - 1));
    }
  }
}
