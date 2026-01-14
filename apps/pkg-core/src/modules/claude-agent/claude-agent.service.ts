import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentRun, ReferenceType } from '@pkg/entities';
import {
  CallParams,
  CallResult,
  OneshotParams,
  AgentParams,
  ModelType,
  ClaudeTaskType,
  UsageStats,
  PeriodStats,
  DailyStatsEntry,
} from './claude-agent.types';

@Injectable()
export class ClaudeAgentService {
  private readonly logger = new Logger(ClaudeAgentService.name);

  constructor(
    private configService: ConfigService,
    @InjectRepository(ClaudeAgentRun)
    private runRepo: Repository<ClaudeAgentRun>,
  ) {}

  /**
   * Universal method for calling Claude
   * Supports both oneshot (structured output) and agent (multi-turn with tools) modes
   */
  async call<T>(params: CallParams<T>): Promise<CallResult<T>> {
    const startTime = Date.now();

    try {
      const result = params.mode === 'oneshot'
        ? await this.executeOneshot<T>(params as OneshotParams<T>)
        : await this.executeAgent<T>(params as AgentParams);

      const run = await this.logRun(params, result, Date.now() - startTime);
      return { ...result, run };

    } catch (error) {
      await this.logError(params, error, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Execute oneshot call with structured output
   */
  private async executeOneshot<T>(params: OneshotParams<T>): Promise<Omit<CallResult<T>, 'run'>> {
    const model = this.getModelString(params.model);
    const timeout = params.timeout || 120000;

    this.logger.debug(`Oneshot call: task=${params.taskType}, model=${model}`);

    const systemPrompt = this.buildOneshotSystemPrompt(params.schema);
    const usage: UsageStats = { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 };
    let result: T | undefined;
    let rawResult: string | undefined;

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeout);

    try {
      for await (const message of query({
        prompt: params.prompt,
        options: {
          model,
          maxTurns: 1,
          systemPrompt,
          allowedTools: [], // No tools in oneshot mode
          abortController,
        },
      })) {
        this.processMessage(message, usage);

        if (message.type === 'result') {
          const resultMessage = message as SDKResultMessage;
          // Check if it's a success result
          if (resultMessage.subtype === 'success' && 'result' in resultMessage) {
            rawResult = (resultMessage as { result?: string }).result || '';
            result = this.parseStructuredOutput<T>(rawResult, params.schema);
          } else if (resultMessage.subtype.startsWith('error')) {
            throw new Error(`Claude returned error: ${resultMessage.subtype}`);
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }

    if (result === undefined) {
      throw new Error(`No result from Claude. Raw: ${rawResult?.slice(0, 200)}`);
    }

    return { data: result, usage };
  }

  /**
   * Execute agent call with tools and multi-turn conversation
   */
  private async executeAgent<T>(params: AgentParams): Promise<Omit<CallResult<T>, 'run'>> {
    const model = this.getModelString(params.model);
    const maxTurns = params.maxTurns || 15;
    const timeout = params.timeout || 300000; // 5 minutes default for agent

    this.logger.debug(`Agent call: task=${params.taskType}, model=${model}, maxTurns=${maxTurns}`);

    const usage: UsageStats = { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 };
    const toolsUsed: string[] = [];
    let turns = 0;
    let result: T | undefined;

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeout);

    try {
      const systemPrompt = this.buildAgentSystemPrompt(params.taskType);

      for await (const message of query({
        prompt: params.prompt,
        options: {
          model,
          maxTurns,
          systemPrompt,
          abortController,
          // Note: Tools are passed via MCP or custom implementation
          // For now, agent mode tracks turns but tool handling is future work
        },
      })) {
        this.processMessage(message, usage);

        if (message.type === 'assistant') {
          turns++;
          if (params.hooks?.onTurn) {
            await params.hooks.onTurn(turns);
          }
        }

        if (message.type === 'result') {
          const resultMessage = message as SDKResultMessage;
          if (resultMessage.subtype === 'success' && 'result' in resultMessage) {
            result = (resultMessage as { result?: unknown }).result as T;
          } else if (resultMessage.subtype.startsWith('error')) {
            throw new Error(`Agent error: ${resultMessage.subtype}`);
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }

    if (result === undefined) {
      throw new Error('Agent finished without result');
    }

    return {
      data: result,
      usage,
      turns,
      toolsUsed: [...new Set(toolsUsed)],
    };
  }

  /**
   * Process SDK message and accumulate usage
   */
  private processMessage(message: SDKMessage, usage: UsageStats): void {
    // Handle usage in assistant messages
    if (message.type === 'assistant' && 'usage' in message && message.usage) {
      const u = message.usage as { inputTokens?: number; outputTokens?: number; costUSD?: number };
      usage.inputTokens += u.inputTokens || 0;
      usage.outputTokens += u.outputTokens || 0;
      usage.totalCostUsd += u.costUSD || 0;
    }
  }

  /**
   * Get full model identifier string
   */
  private getModelString(model?: ModelType): string {
    const map: Record<string, string> = {
      'haiku': 'claude-haiku-4-5-20251001',
      'sonnet': 'claude-sonnet-4-5-20250514',
      'opus': 'claude-opus-4-5-20251101',
    };
    return map[model || 'sonnet'];
  }

  /**
   * Build system prompt for oneshot mode
   */
  private buildOneshotSystemPrompt(schema: object): string {
    return `You must respond with valid JSON that matches the following schema. Do not include any other text, only the JSON object.

Schema:
${JSON.stringify(schema, null, 2)}`;
  }

  /**
   * Build system prompt for agent mode
   */
  private buildAgentSystemPrompt(taskType: ClaudeTaskType): string {
    const prompts: Record<string, string> = {
      recall: 'You help find information from past conversations. Use search tools to find relevant messages. Try different search terms if initial queries return no results.',
      meeting_prep: 'You prepare briefings for upcoming meetings. Gather context about the person, recent interactions, and any open action items.',
      daily_brief: 'You create daily summaries. Check scheduled meetings, pending reminders, and open action items for the day.',
      action: 'You help take actions like sending messages or creating reminders. Always confirm the details with the user before executing any action.',
      summarization: 'You summarize conversations, extracting key points, decisions, and action items.',
      profile_aggregation: 'You aggregate information about a person from multiple interactions to build a relationship profile.',
      context_synthesis: 'You synthesize context from multiple sources to prepare for an interaction.',
      fact_extraction: 'You extract structured facts (like job title, company, contact info) from messages.',
    };
    return prompts[taskType] || '';
  }

  /**
   * Parse structured output from text response
   */
  private parseStructuredOutput<T>(result: string, schema: object): T {
    if (!result) {
      throw new Error('Empty result from Claude');
    }

    // Try direct JSON parse first
    try {
      return JSON.parse(result) as T;
    } catch {
      // Try extracting from markdown code block
      const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch?.[1]) {
        try {
          return JSON.parse(jsonMatch[1].trim()) as T;
        } catch {
          // Fall through to error
        }
      }

      throw new Error(`Failed to parse JSON from result: ${result.slice(0, 200)}`);
    }
  }

  /**
   * Log successful run to database
   */
  private async logRun(
    params: CallParams<unknown>,
    result: Omit<CallResult<unknown>, 'run'>,
    durationMs: number,
  ): Promise<ClaudeAgentRun> {
    const run = this.runRepo.create({
      taskType: params.taskType,
      mode: params.mode,
      model: this.getModelString(params.model),
      tokensIn: result.usage.inputTokens || null,
      tokensOut: result.usage.outputTokens || null,
      costUsd: result.usage.totalCostUsd || null,
      durationMs,
      turnsCount: result.turns || 1,
      toolsUsed: result.toolsUsed?.length ? result.toolsUsed : null,
      success: true,
      referenceType: (params.referenceType || null) as ReferenceType,
      referenceId: params.referenceId || null,
      inputPreview: params.prompt.slice(0, 500),
      outputPreview: JSON.stringify(result.data).slice(0, 500),
      createdDate: new Date(),
    });

    const saved = await this.runRepo.save(run);

    this.logger.log(
      `Claude ${params.mode} success: task=${params.taskType}, duration=${durationMs}ms, ` +
      `tokens=${result.usage.inputTokens || '?'}/${result.usage.outputTokens || '?'}`
    );

    return saved;
  }

  /**
   * Log failed run to database
   */
  private async logError(
    params: CallParams<unknown>,
    error: unknown,
    durationMs: number,
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);

    const run = this.runRepo.create({
      taskType: params.taskType,
      mode: params.mode,
      model: this.getModelString(params.model),
      durationMs,
      turnsCount: 1,
      success: false,
      errorMessage,
      referenceType: (params.referenceType || null) as ReferenceType,
      referenceId: params.referenceId || null,
      inputPreview: params.prompt.slice(0, 500),
      createdDate: new Date(),
    });

    await this.runRepo.save(run);

    this.logger.error(`Claude ${params.mode} error: task=${params.taskType}, error=${errorMessage}`);
  }

  /**
   * Get usage statistics for a period
   */
  async getStats(period: 'day' | 'week' | 'month' = 'month'): Promise<PeriodStats> {
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
  async getDailyStats(days = 30): Promise<DailyStatsEntry[]> {
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
