import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import * as path from 'path';
import { PendingFactService } from '../resolution/pending-fact/pending-fact.service';

export interface ExtractedFact {
  factType: string;
  value: string;
  confidence: number;
  sourceQuote: string;
}

export interface ExtractionResult {
  entityId: string;
  facts: ExtractedFact[];
  tokensUsed?: number;
}

// JSON Schema for structured output (simplified, without enum for stability)
const FACTS_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          factType: { type: 'string' },
          value: { type: 'string' },
          confidence: { type: 'number' },
          sourceQuote: { type: 'string' },
        },
        required: ['factType', 'value', 'confidence', 'sourceQuote'],
      },
    },
  },
  required: ['facts'],
});

@Injectable()
export class FactExtractionService {
  private readonly logger = new Logger(FactExtractionService.name);
  private readonly workspacePath: string;
  private readonly claudePath: string;
  private readonly timeoutMs = 60000; // 60 seconds timeout

  constructor(private pendingFactService: PendingFactService) {
    // Claude workspace directory with CLAUDE.md and agents
    // Use process.cwd() which is apps/pkg-core, go up to PKG root
    const projectRoot = process.env.PKG_PROJECT_ROOT || path.resolve(process.cwd(), '../..');
    this.workspacePath = path.join(projectRoot, 'claude-workspace');

    // Claude CLI path - must be set via environment variable or be available in PATH
    this.claudePath = process.env.CLAUDE_CLI_PATH || 'claude';
    this.logger.log(`Using Claude workspace: ${this.workspacePath}`);
    this.logger.log(`Using Claude CLI: ${this.claudePath}`);
  }

  /**
   * Extract facts from message - optimized for token economy
   */
  async extractFacts(params: {
    entityId: string;
    entityName: string;
    messageContent: string;
    messageId?: string;
    interactionId?: string;
  }): Promise<ExtractionResult> {
    const { entityId, entityName, messageContent, messageId, interactionId } = params;

    // Skip very short messages
    if (messageContent.length < 20) {
      return { entityId, facts: [] };
    }

    // Truncate very long messages to save tokens
    const truncatedContent = messageContent.length > 1500
      ? messageContent.substring(0, 1500) + '...'
      : messageContent;

    const prompt = this.buildCompactPrompt(entityName, truncatedContent);

    try {
      const response = await this.callClaudeCli(prompt);
      const facts = this.parseResponse(response);

      // Filter out low confidence facts
      const validFacts = facts.filter(f => f.confidence >= 0.6);

      // Try to save extracted facts as pending (don't fail if save fails)
      for (const fact of validFacts) {
        try {
          await this.pendingFactService.create({
            entityId,
            factType: fact.factType,
            value: fact.value,
            confidence: fact.confidence,
            sourceQuote: fact.sourceQuote,
            sourceMessageId: messageId,
            sourceInteractionId: interactionId,
          });
        } catch (saveError) {
          const msg = saveError instanceof Error ? saveError.message : String(saveError);
          this.logger.warn(`Failed to save pending fact: ${msg}`);
        }
      }

      this.logger.log(`Extracted ${validFacts.length} facts for ${entityName}`);
      return { entityId, facts: validFacts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Extraction failed: ${message}`);
      return { entityId, facts: [] };
    }
  }

  /**
   * Batch extract from multiple messages - more efficient
   */
  async extractFactsBatch(params: {
    entityId: string;
    entityName: string;
    messages: Array<{ id: string; content: string; interactionId?: string }>;
  }): Promise<ExtractionResult> {
    const { entityId, entityName, messages } = params;

    // Combine messages into single context
    const combined = messages
      .map((m, i) => `[${i + 1}] ${m.content}`)
      .join('\n---\n')
      .substring(0, 3000); // Limit total size

    const prompt = this.buildBatchPrompt(entityName, combined);

    try {
      const response = await this.callClaudeCli(prompt);
      const facts = this.parseResponse(response);
      const validFacts = facts.filter(f => f.confidence >= 0.6);

      for (const fact of validFacts) {
        await this.pendingFactService.create({
          entityId,
          factType: fact.factType,
          value: fact.value,
          confidence: fact.confidence,
          sourceQuote: fact.sourceQuote,
          sourceInteractionId: messages[0]?.interactionId,
        });
      }

      return { entityId, facts: validFacts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Batch extraction failed: ${message}`);
      return { entityId, facts: [] };
    }
  }

  /**
   * Compact prompt - single line for shell safety
   */
  private buildCompactPrompt(name: string, text: string): string {
    // Remove newlines from text for shell safety
    const cleanText = text.replace(/\n/g, ' ').substring(0, 500);
    return `Extract facts about ${name}. Fact types: position,company,department,phone,email,telegram. Text: ${cleanText}`;
  }

  /**
   * Batch prompt for multiple messages
   */
  private buildBatchPrompt(name: string, text: string): string {
    const cleanText = text.replace(/\n/g, ' ').substring(0, 1000);
    return `Extract facts about ${name}. Deduplicate. Fact types: position,company,department,phone,email,telegram. Messages: ${cleanText}`;
  }

  /**
   * Call Claude CLI with timeout, haiku model, and structured output
   * Uses spawn with stdin='ignore' to prevent hanging
   */
  private callClaudeCli(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '--print',
        '--model', 'haiku',
        '--output-format', 'json',
        '--json-schema', FACTS_SCHEMA,
        '-p', prompt,
      ];

      this.logger.debug(`Executing claude with ${args.length} args: ${this.claudePath}`);

      const proc = spawn(this.claudePath, args, {
        cwd: this.workspacePath,
        stdio: ['ignore', 'pipe', 'pipe'], // Key: ignore stdin to prevent hanging
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error('Claude CLI timeout'));
      }, this.timeoutMs);

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code: number | null) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`Claude CLI failed (${code}): ${stderr}`));
          return;
        }
        resolve(stdout.trim());
      });

      proc.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Parse response from Claude CLI with structured output
   * See: https://code.claude.com/docs/en/headless#get-structured-output
   *
   * With --output-format json --json-schema, response contains structured_output field
   */
  private parseResponse(response: string): ExtractedFact[] {
    this.logger.debug(`Parsing response (${response.length} chars)`);

    try {
      let facts: ExtractedFact[] = [];
      const data = JSON.parse(response);

      // Option 1: Response is object with structured_output (headless without --print)
      if (data.structured_output?.facts) {
        this.logger.debug(`Found structured_output in root with ${data.structured_output.facts.length} facts`);
        facts = data.structured_output.facts;
      }
      // Option 2: Response is array of messages (with --print flag)
      else if (Array.isArray(data)) {
        const resultMsg = data.find((m: { type: string }) => m.type === 'result');

        // 2a: structured_output in result object
        if (resultMsg?.structured_output?.facts) {
          this.logger.debug(`Found structured_output in result with ${resultMsg.structured_output.facts.length} facts`);
          facts = resultMsg.structured_output.facts;
        }
        // 2b: Fallback - JSON in text result (markdown code block)
        else if (resultMsg?.result) {
          this.logger.debug(`Fallback: parsing result text: ${resultMsg.result.substring(0, 200)}...`);
          const jsonMatch = resultMsg.result.match(/```json\s*([\s\S]*?)```/);
          if (jsonMatch?.[1]) {
            facts = JSON.parse(jsonMatch[1].trim());
          }
        }
      }

      // Filter and normalize facts
      const validFacts = facts
        .filter((f) => f.factType && f.value && typeof f.confidence === 'number')
        .map((f) => ({
          factType: f.factType.toLowerCase(),
          value: String(f.value).trim(),
          confidence: Math.min(1, Math.max(0, f.confidence)),
          sourceQuote: String(f.sourceQuote || '').substring(0, 200),
        }));

      this.logger.debug(`Parsed ${validFacts.length} valid facts from ${facts.length} total`);
      return validFacts;
    } catch (e) {
      this.logger.warn(`Failed to parse extraction response: ${e}`);
      return [];
    }
  }
}
