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

const FACT_TYPES = ['position', 'company', 'department', 'phone', 'email', 'telegram', 'specialization', 'birthday', 'name'];

// JSON Schema for structured output validation
const FACTS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          factType: {
            type: 'string',
            enum: FACT_TYPES,
          },
          value: { type: 'string' },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
          },
          sourceQuote: { type: 'string' },
        },
        required: ['factType', 'value', 'confidence', 'sourceQuote'],
      },
    },
  },
  required: ['facts'],
};

@Injectable()
export class FactExtractionService {
  private readonly logger = new Logger(FactExtractionService.name);
  private readonly workspacePath: string;
  private readonly timeoutMs = 30000; // 30 seconds timeout
  private readonly jsonSchema: string;

  constructor(private pendingFactService: PendingFactService) {
    // Claude workspace directory with CLAUDE.md and agents
    const projectRoot = process.env.PKG_PROJECT_ROOT || path.resolve(__dirname, '../../../../../../');
    this.workspacePath = path.join(projectRoot, 'claude-workspace');
    this.jsonSchema = JSON.stringify(FACTS_JSON_SCHEMA);
    this.logger.log(`Using Claude workspace: ${this.workspacePath}`);
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

      // Save extracted facts as pending
      for (const fact of validFacts) {
        await this.pendingFactService.create({
          entityId,
          factType: fact.factType,
          value: fact.value,
          confidence: fact.confidence,
          sourceQuote: fact.sourceQuote,
          sourceMessageId: messageId,
          sourceInteractionId: interactionId,
        });
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
   * Compact prompt - JSON schema handles output format
   */
  private buildCompactPrompt(name: string, text: string): string {
    return `Extract facts about "${name}" from the text.

Rules:
- Only extract explicitly stated facts
- confidence: 0.9+ for explicit statements, 0.6-0.8 for indirect
- sourceQuote: exact quote from text (max 100 chars)
- Return empty facts array if no facts found

Text:
${text}`;
  }

  /**
   * Batch prompt for multiple messages
   */
  private buildBatchPrompt(name: string, text: string): string {
    return `Extract facts about "${name}" from the messages. Deduplicate similar facts.

Rules:
- Only extract explicitly stated facts
- confidence: 0.9+ for explicit statements, 0.6-0.8 for indirect
- sourceQuote: exact quote from text (max 100 chars)
- Return empty facts array if no facts found

Messages:
${text}`;
  }

  /**
   * Call Claude CLI with timeout, haiku model, and structured output
   */
  private callClaudeCli(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Use haiku for speed and cost efficiency
      // --json-schema ensures valid JSON output matching our schema
      // --output-format json returns structured response
      const args = [
        '--print',
        '--model', 'haiku',
        '--output-format', 'json',
        '--json-schema', this.jsonSchema,
        '-p', prompt,
      ];

      const proc = spawn('claude', args, {
        cwd: this.workspacePath,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: this.timeoutMs,
      });

      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error('Claude CLI timeout'));
      }, this.timeoutMs);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`Claude CLI failed (${code}): ${stderr}`));
          return;
        }
        resolve(stdout.trim());
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Parse structured JSON response from Claude CLI
   * Format: JSON stream with structured_output in last object
   */
  private parseResponse(response: string): ExtractedFact[] {
    try {
      // Response is a JSON array (stream format)
      const parsed = JSON.parse(response);

      let facts: ExtractedFact[] = [];

      if (Array.isArray(parsed)) {
        // Find the result object with structured_output
        const resultObj = parsed.find(
          (obj) => obj.type === 'result' && obj.structured_output,
        );
        if (resultObj?.structured_output?.facts) {
          facts = resultObj.structured_output.facts;
        }
      } else if (parsed.structured_output?.facts) {
        // Single object with structured_output
        facts = parsed.structured_output.facts;
      } else if (parsed.facts) {
        // Direct facts array
        facts = parsed.facts;
      }

      return facts
        .filter((f) => f.factType && f.value && typeof f.confidence === 'number')
        .filter((f) => FACT_TYPES.includes(f.factType.toLowerCase()))
        .map((f) => ({
          factType: f.factType.toLowerCase(),
          value: String(f.value).trim(),
          confidence: Math.min(1, Math.max(0, f.confidence)),
          sourceQuote: String(f.sourceQuote || '').substring(0, 200),
        }));
    } catch (e) {
      this.logger.warn(`Failed to parse extraction response: ${e}`);
      return [];
    }
  }
}
