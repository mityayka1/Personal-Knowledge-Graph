import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Schema type identifiers
 */
export type SchemaType = 'summarization' | 'profile' | 'context' | 'fact-extraction';

/**
 * Service for loading JSON schemas for Claude structured output.
 * Provides centralized schema loading with caching and fallback support.
 */
@Injectable()
export class SchemaLoaderService {
  private readonly logger = new Logger(SchemaLoaderService.name);
  private readonly schemasPath: string;
  private readonly schemaCache = new Map<string, object>();

  constructor(private configService: ConfigService) {
    // Get workspace path from config or use default
    const workspacePath = this.configService.get<string>(
      'claude.workspacePath',
      path.join(process.cwd(), '..', '..', 'claude-workspace')
    );
    this.schemasPath = path.join(workspacePath, 'schemas');
  }

  /**
   * Load a schema by type with optional inline fallback.
   *
   * @param schemaType - The type of schema to load
   * @param inlineFallback - Optional fallback schema if file loading fails
   * @returns The loaded schema object
   * @throws Error if no fallback provided and file loading fails
   */
  load(schemaType: SchemaType, inlineFallback?: object): object {
    // Check cache first
    const cached = this.schemaCache.get(schemaType);
    if (cached) {
      return cached;
    }

    const schemaFileName = `${schemaType}-schema.json`;
    const schemaPath = path.join(this.schemasPath, schemaFileName);

    try {
      const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent);
      this.schemaCache.set(schemaType, schema);
      this.logger.debug(`Loaded schema "${schemaType}" from ${schemaPath}`);
      return schema;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (inlineFallback) {
        this.logger.warn(
          `Could not load schema "${schemaType}" from "${schemaPath}": ${errorMessage}. Using inline fallback.`
        );
        this.schemaCache.set(schemaType, inlineFallback);
        return inlineFallback;
      }

      this.logger.error(
        `Failed to load schema "${schemaType}" from "${schemaPath}": ${errorMessage}`
      );
      throw new Error(`Schema "${schemaType}" not found and no fallback provided`);
    }
  }

  /**
   * Load a schema from a custom path.
   *
   * @param customPath - Full path to the schema file
   * @param cacheKey - Optional key for caching
   * @param inlineFallback - Optional fallback schema
   * @returns The loaded schema object
   */
  loadFromPath(customPath: string, cacheKey?: string, inlineFallback?: object): object {
    const key = cacheKey || customPath;

    // Check cache first
    const cached = this.schemaCache.get(key);
    if (cached) {
      return cached;
    }

    try {
      const schemaContent = fs.readFileSync(customPath, 'utf-8');
      const schema = JSON.parse(schemaContent);
      this.schemaCache.set(key, schema);
      this.logger.debug(`Loaded schema from ${customPath}`);
      return schema;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (inlineFallback) {
        this.logger.warn(
          `Could not load schema from "${customPath}": ${errorMessage}. Using inline fallback.`
        );
        this.schemaCache.set(key, inlineFallback);
        return inlineFallback;
      }

      this.logger.error(`Failed to load schema from "${customPath}": ${errorMessage}`);
      throw new Error(`Schema at "${customPath}" not found and no fallback provided`);
    }
  }

  /**
   * Clear the schema cache (useful for testing or hot-reload scenarios).
   */
  clearCache(): void {
    this.schemaCache.clear();
    this.logger.debug('Schema cache cleared');
  }

  /**
   * Check if a schema is cached.
   */
  isCached(schemaType: SchemaType): boolean {
    return this.schemaCache.has(schemaType);
  }
}
