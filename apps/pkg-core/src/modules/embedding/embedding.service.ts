import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { EMBEDDING_DIMENSIONS } from '@pkg/shared';

@Injectable()
export class EmbeddingService implements OnModuleInit {
  private openai: OpenAI | null = null;
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly model: string;

  constructor(private configService: ConfigService) {
    this.model = this.configService.get<string>('app.embeddingModel', 'text-embedding-3-small');
  }

  onModuleInit() {
    const apiKey = this.configService.get<string>('app.openaiApiKey');

    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
      this.logger.log('OpenAI client initialized');
    } else {
      this.logger.warn('OpenAI API key not configured, embeddings will use random vectors');
    }
  }

  async generate(text: string): Promise<number[]> {
    if (!this.openai) {
      // Return random vector for development without API key
      return this.generateRandomVector();
    }

    try {
      const response = await this.openai.embeddings.create({
        model: this.model,
        input: text.slice(0, 8000), // Limit input length
      });

      return response.data[0].embedding;
    } catch (error: any) {
      this.logger.error(`Failed to generate embedding: ${error.message}`);
      throw error;
    }
  }

  async generateBatch(texts: string[]): Promise<number[][]> {
    if (!this.openai) {
      return texts.map(() => this.generateRandomVector());
    }

    try {
      const response = await this.openai.embeddings.create({
        model: this.model,
        input: texts.map(t => t.slice(0, 8000)),
      });

      return response.data.map(d => d.embedding);
    } catch (error: any) {
      this.logger.error(`Failed to generate batch embeddings: ${error.message}`);
      throw error;
    }
  }

  private generateRandomVector(): number[] {
    // Generate random unit vector for development
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => Math.random() - 0.5);
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return vector.map(v => v / magnitude);
  }
}
