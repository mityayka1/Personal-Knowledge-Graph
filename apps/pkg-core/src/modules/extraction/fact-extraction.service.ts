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

@Injectable()
export class FactExtractionService {
  private readonly logger = new Logger(FactExtractionService.name);
  private readonly projectRoot: string;
  private readonly timeoutMs = 30000; // 30 seconds timeout

  constructor(private pendingFactService: PendingFactService) {
    // PKG project root where CLAUDE.md and .claude/agents are located
    // From dist/modules/extraction/ -> dist/modules/ -> dist/ -> pkg-core/ -> apps/ -> PKG/
    this.projectRoot = process.env.PKG_PROJECT_ROOT || path.resolve(__dirname, '../../../../../../');
    this.logger.log(`Using project root: ${this.projectRoot}`);
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
      this.logger.error(`Extraction failed: ${error.message}`);
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
      this.logger.error(`Batch extraction failed: ${error.message}`);
      return { entityId, facts: [] };
    }
  }

  /**
   * Compact prompt - references fact-extractor agent instructions
   */
  private buildCompactPrompt(name: string, text: string): string {
    // Reference the agent for context, but keep prompt minimal
    return `@.claude/agents/fact-extractor.md

Extract facts about "${name}":

${text}

JSON only:`;
  }

  /**
   * Batch prompt for multiple messages
   */
  private buildBatchPrompt(name: string, text: string): string {
    return `@.claude/agents/fact-extractor.md

Extract facts about "${name}" from messages. Deduplicate.

${text}

JSON only:`;
  }

  /**
   * Call Claude CLI with timeout and haiku model
   */
  private callClaudeCli(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Use haiku for speed and cost efficiency
      const args = ['--print', '--model', 'haiku', '-p', prompt];

      const proc = spawn('claude', args, {
        cwd: this.projectRoot,
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
   * Parse response with fallback
   */
  private parseResponse(response: string): ExtractedFact[] {
    try {
      // Try to find JSON array
      const jsonMatch = response.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) {
        return [];
      }

      const facts = JSON.parse(jsonMatch[0]) as ExtractedFact[];

      return facts
        .filter((f) => f.factType && f.value && typeof f.confidence === 'number')
        .filter((f) => FACT_TYPES.includes(f.factType.toLowerCase()))
        .map((f) => ({
          factType: f.factType.toLowerCase(),
          value: String(f.value).trim(),
          confidence: Math.min(1, Math.max(0, f.confidence)),
          sourceQuote: String(f.sourceQuote || '').substring(0, 200),
        }));
    } catch {
      this.logger.warn('Failed to parse extraction response');
      return [];
    }
  }
}
