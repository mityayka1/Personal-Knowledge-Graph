import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { query, type SDKMessage, type SDKResultMessage, type SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
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
  ToolCategory,
  AgentHooks,
} from './claude-agent.types';
import { ToolsRegistryService } from './tools-registry.service';
import {
  SDKAssistantUsage,
  SDKResultFields,
  accumulateSDKUsage,
  accumulateSDKResultUsage,
} from './sdk-transformer';

/**
 * Content block with tool use
 */
interface ToolUseBlock {
  type: 'tool_use';
  name?: string;
  input?: unknown;
}

/**
 * Extract tool uses from assistant message content
 */
function extractToolUses(content: unknown[]): ToolUseBlock[] {
  return content.filter(
    (block): block is ToolUseBlock =>
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      (block as { type: unknown }).type === 'tool_use'
  );
}

/**
 * MCP server name used for our default tools
 */
const MCP_SERVER_NAME = 'pkg-tools';

/**
 * Clean tool name from MCP format
 * mcp__server-name__tool_name -> tool_name
 */
function cleanToolName(mcpName: string): string {
  // Match any MCP format: mcp__<server>__<tool>
  // Server names can contain hyphens and alphanumerics
  const match = mcpName.match(/^mcp__[\w-]+__(.+)$/);
  return match ? match[1] : mcpName;
}

@Injectable()
export class ClaudeAgentService {
  private readonly logger = new Logger(ClaudeAgentService.name);

  constructor(
    private configService: ConfigService,
    @InjectRepository(ClaudeAgentRun)
    private runRepo: Repository<ClaudeAgentRun>,
    private toolsRegistry: ToolsRegistryService,
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
   * Execute oneshot call with structured output.
   * Uses SDK outputFormat for guaranteed JSON schema compliance
   * (constrained decoding — model cannot produce invalid JSON).
   */
  private async executeOneshot<T>(params: OneshotParams<T>): Promise<Omit<CallResult<T>, 'run'>> {
    const model = this.getModelString(params.model);
    const timeout = params.timeout || 120000;

    this.logger.debug(`Oneshot call: task=${params.taskType}, model=${model}`);

    const usage: UsageStats = { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 };
    let result: T | undefined;
    let rawResult: string | undefined;

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeout);

    try {
      // Use SDK outputFormat for reliable structured output.
      // No manual "output JSON only" system prompt needed —
      // SDK handles format enforcement via constrained decoding.
      //
      // IMPORTANT: maxTurns must be >= 2 for structured output because:
      // - Turn 1: Claude calls StructuredOutput tool
      // - Turn 2: Claude completes after tool result
      // Default is 3 for safety margin.
      const queryOptions: Record<string, unknown> = {
        model,
        maxTurns: params.maxTurns || 3,
        abortController,
        outputFormat: {
          type: 'json_schema',
          schema: params.schema,
          strict: true,
        },
      };

      for await (const message of query({
        prompt: params.prompt,
        options: queryOptions as Parameters<typeof query>[0]['options'],
      })) {
        this.accumulateUsage(message, usage);

        if (message.type === 'result') {
          const resultMessage = message as SDKResultMessage;

          // Extract usage from result message (SDK puts usage here, not in assistant)
          this.accumulateUsageFromResult(resultMessage, usage);

          if (resultMessage.subtype === 'success') {
            const msgAny = resultMessage as Record<string, unknown>;

            // Primary: SDK structured_output (constrained decoding, schema-validated)
            if (msgAny.structured_output !== undefined && msgAny.structured_output !== null) {
              result = msgAny.structured_output as T;
              this.logger.debug('[oneshot] Got structured output from SDK');
            } else {
              // Fallback: text parsing (safety net if SDK doesn't return structured_output)
              rawResult = (msgAny.result as string) || '';
              this.logger.warn(`[oneshot] No structured_output, text fallback: ${rawResult.slice(0, 200)}`);
              result = this.parseStructuredOutput<T>(rawResult, params.schema);
            }
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
    const toolCategories = params.toolCategories || ['all'];
    const budgetUsd = params.budgetUsd;

    this.logger.debug(
      `Agent call: task=${params.taskType}, model=${model}, maxTurns=${maxTurns}, ` +
      `tools=${toolCategories.join(',')}, budget=${budgetUsd ?? 'unlimited'}`
    );

    const usage: UsageStats = { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 };
    const toolsUsed: string[] = [];
    let turns = 0;
    let result: T | undefined;
    let budgetExceeded = false;

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeout);

    try {
      const systemPrompt = this.buildAgentSystemPrompt(params.taskType);

      // Use custom MCP server if provided, otherwise create from toolsRegistry
      let mcpServerName: string;
      let mcpServer: unknown;
      let allowedTools: string[];

      if (params.customMcp) {
        mcpServerName = params.customMcp.name;
        mcpServer = params.customMcp.server;
        allowedTools = params.customMcp.toolNames;
        this.logger.log(`Using custom MCP server '${mcpServerName}' with tools: ${allowedTools.join(', ')}`);
      } else {
        mcpServerName = MCP_SERVER_NAME;
        mcpServer = this.toolsRegistry.createMcpServer(toolCategories as ToolCategory[]);
        allowedTools = this.toolsRegistry.getToolNames(toolCategories as ToolCategory[]);
        this.logger.log(`MCP server created with tools: ${allowedTools.join(', ')}`);
      }

      // Build query options
      // Note: SDK automatically adds StructuredOutput tool when outputFormat is specified
      // allowedTools just auto-approves our MCP tools (avoids permission prompts)
      const queryOptions: Record<string, unknown> = {
        model,
        maxTurns,
        systemPrompt,
        abortController,
        mcpServers: {
          [mcpServerName]: mcpServer,
        },
        allowedTools,
      };

      // Add structured output format if specified
      if (params.outputFormat) {
        queryOptions.outputFormat = params.outputFormat;
        this.logger.debug('Using structured output with JSON schema');
      }

      for await (const message of query({
        prompt: params.prompt,
        options: queryOptions as Parameters<typeof query>[0]['options'],
      })) {
        this.accumulateUsage(message, usage);

        // Budget check: abort if cost exceeds limit
        if (budgetUsd !== undefined && usage.totalCostUsd > budgetUsd) {
          this.logger.warn(
            `Budget exceeded: $${usage.totalCostUsd.toFixed(4)} > $${budgetUsd}, aborting`
          );
          budgetExceeded = true;
          abortController.abort();
          break;
        }

        if (message.type === 'assistant') {
          turns++;
          await this.processAssistantMessage(
            message as SDKAssistantMessage,
            toolsUsed,
            params.hooks,
          );

          if (params.hooks?.onTurn) {
            await params.hooks.onTurn(turns);
          }
        }

        // Handle tool results for onToolResult hook
        if (message.type === 'user' && params.hooks?.onToolResult) {
          await this.processToolResults(message, params.hooks.onToolResult);
        }

        if (message.type === 'result') {
          const resultMessage = message as SDKResultMessage;
          // Debug logging for structured output (run with LOG_LEVEL=debug to see)
          const msgAny = resultMessage as Record<string, unknown>;
          this.logger.debug(`Result keys: ${Object.keys(msgAny).join(', ')}`);
          this.logger.debug(`Has structured_output: ${'structured_output' in msgAny}, value: ${JSON.stringify(msgAny.structured_output)?.slice(0, 200)}`);
          this.logger.debug(`Result subtype: ${resultMessage.subtype}, toolsUsed so far: ${toolsUsed.join(', ')}`);
          if ('result' in msgAny) {
            this.logger.debug(`Text result: ${String(msgAny.result).slice(0, 300)}`);
          }

          if (resultMessage.subtype === 'success') {
            // When outputFormat is specified, ONLY use structured_output field
            // No text parsing fallback - it's unreliable (anti-pattern)
            if (params.outputFormat) {
              if (msgAny.structured_output !== undefined && msgAny.structured_output !== null) {
                result = msgAny.structured_output as T;
                this.logger.debug('Got structured output from agent');
              } else {
                // Log tools used for debugging
                this.logger.warn(`StructuredOutput not returned. Tools used: ${toolsUsed.join(', ')}`);
                throw new Error(
                  'Agent did not return structured_output. ' +
                  'Ensure prompt instructs Claude to use StructuredOutput tool.'
                );
              }
            } else if ('result' in resultMessage) {
              // No outputFormat specified - use text result as-is
              result = msgAny.result as T;
              this.logger.debug('Using text result (no outputFormat specified)');
            }
          } else if (resultMessage.subtype.startsWith('error')) {
            throw new Error(`Agent error: ${resultMessage.subtype}`);
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }

    if (result === undefined) {
      if (budgetExceeded) {
        throw new Error(`Budget exceeded: $${usage.totalCostUsd.toFixed(4)} > $${budgetUsd}`);
      }
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
   * Process assistant message: track tool usage and call hooks
   */
  private async processAssistantMessage(
    message: SDKAssistantMessage,
    toolsUsed: string[],
    hooks?: AgentHooks,
  ): Promise<void> {
    const content = message.message?.content;
    if (!content || !Array.isArray(content)) {
      return;
    }

    const toolUses = extractToolUses(content);

    for (const toolUse of toolUses) {
      const rawName = toolUse.name || 'unknown';
      const cleanName = cleanToolName(rawName);

      // Track tool usage
      toolsUsed.push(cleanName);
      this.logger.debug(`Tool used: ${cleanName}`);

      // Call hook if defined
      if (hooks?.onToolUse) {
        const approval = await hooks.onToolUse(cleanName, toolUse.input);
        if (!approval.approve) {
          this.logger.warn(`Tool ${cleanName} not approved: ${approval.reason}`);
        }
      }
    }
  }

  /**
   * Process tool results from user message and call onToolResult hook
   * SDK user messages contain tool_result blocks with tool execution results
   */
  private async processToolResults(
    message: SDKMessage,
    onToolResult: (toolName: string, result: string) => Promise<void>,
  ): Promise<void> {
    const messageAny = message as Record<string, unknown>;
    const content = messageAny.message && typeof messageAny.message === 'object'
      ? (messageAny.message as Record<string, unknown>).content
      : undefined;

    if (!content || !Array.isArray(content)) {
      return;
    }

    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        (block as { type: unknown }).type === 'tool_result'
      ) {
        const toolResultBlock = block as {
          type: 'tool_result';
          tool_use_id?: string;
          content?: string | Array<{ type: string; text?: string }>;
        };

        // Extract tool name from tool_use_id if available (format: toolu_xxx)
        // Note: SDK doesn't always include tool name in result, so we use id as fallback
        const toolId = toolResultBlock.tool_use_id || 'unknown';

        // Extract result text
        let resultText: string;
        if (typeof toolResultBlock.content === 'string') {
          resultText = toolResultBlock.content;
        } else if (Array.isArray(toolResultBlock.content)) {
          resultText = toolResultBlock.content
            .filter((c): c is { type: string; text: string } => c.type === 'text' && typeof c.text === 'string')
            .map(c => c.text)
            .join('\n');
        } else {
          resultText = '';
        }

        try {
          await onToolResult(toolId, resultText);
        } catch (error) {
          this.logger.warn(`onToolResult hook error for ${toolId}: ${error}`);
        }
      }
    }
  }

  /**
   * Accumulate usage stats from SDK assistant message
   * @see sdk-transformer.ts for snake_case → camelCase transformation
   */
  private accumulateUsage(message: SDKMessage, usage: UsageStats): void {
    if (message.type === 'assistant' && 'usage' in message && message.usage) {
      accumulateSDKUsage(message.usage as SDKAssistantUsage, usage);
    }
  }

  /**
   * Accumulate usage stats from SDK result message
   * @see sdk-transformer.ts for snake_case → camelCase transformation
   */
  private accumulateUsageFromResult(resultMessage: SDKResultMessage, usage: UsageStats): void {
    accumulateSDKResultUsage(resultMessage as unknown as SDKResultFields, usage);
  }

  /**
   * Get full model identifier string
   */
  private getModelString(model?: ModelType): string {
    const map: Record<string, string> = {
      'haiku': 'claude-haiku-4-5-20251001',
      'sonnet': 'claude-sonnet-4-5-20250929',
      'opus': 'claude-opus-4-5-20251101',
    };
    return map[model || 'sonnet'];
  }

  /**
   * Build system prompt for agent mode
   */
  private buildAgentSystemPrompt(taskType: ClaudeTaskType): string {
    const prompts: Record<string, string> = {
      recall: 'You help find information from past conversations. Use search tools to find relevant messages. After finding results, you MUST call StructuredOutput tool to return the final answer. Never respond with plain text.',
      meeting_prep: 'You prepare briefings for upcoming meetings. Gather context about the person, recent interactions, and any open action items. Always use StructuredOutput to return the final brief.',
      daily_brief: 'You create daily summaries. Check scheduled meetings, pending reminders, and open action items for the day.',
      action: 'You help take actions like sending messages or creating reminders. Always confirm the details with the user before executing any action.',
      summarization: 'You summarize conversations, extracting key points, decisions, and action items.',
      profile_aggregation: 'You aggregate information about a person from multiple interactions to build a relationship profile.',
      context_synthesis: 'You synthesize context from multiple sources to prepare for an interaction.',
      fact_extraction: 'You extract structured facts (like job title, company, contact info) from messages.',
      fact_fusion: 'You analyze two facts about the same entity and decide how to merge them: confirm, enrich, supersede, coexist, or flag as conflict.',
      unified_extraction: 'You extract facts, events, and relations from messages using the provided tools. Follow the sectioned instructions in the prompt.',
      fact_dedup_review: 'Ты эксперт по дедупликации фактов. Анализируй новые факты в контексте существующих и определяй, являются ли они дубликатами. Учитывай сокращения, разные форматы дат, синонимы и перефразирования. Отвечай строго по JSON схеме.',
    };
    return prompts[taskType] || '';
  }

  /**
   * Parse structured output from text response.
   * Tries multiple extraction strategies when Claude returns
   * JSON embedded in conversational text.
   */
  private parseStructuredOutput<T>(result: string, schema: object): T {
    if (!result) {
      throw new Error('Empty result from Claude');
    }

    // Strategy 1: Direct JSON parse (clean response)
    try {
      return JSON.parse(result) as T;
    } catch {
      // Not valid JSON, try extraction strategies
    }

    // Strategy 2: Extract from markdown code block (```json ... ```)
    const codeBlockMatch = result.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch?.[1]) {
      try {
        return JSON.parse(codeBlockMatch[1].trim()) as T;
      } catch {
        // Not valid JSON inside code block
      }
    }

    // Strategy 3: Find outermost JSON object in mixed text
    // Handles cases like: "Here are the results:\n{...}\nLet me know if..."
    const firstBrace = result.indexOf('{');
    const lastBrace = result.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(result.slice(firstBrace, lastBrace + 1)) as T;
      } catch {
        // Braces found but content not valid JSON
      }
    }

    throw new Error(`Failed to parse JSON from result: ${result.slice(0, 200)}`);
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
