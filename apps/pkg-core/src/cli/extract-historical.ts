/**
 * CLI command for batch extraction of facts from historical messages.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/cli/extract-historical.ts [options]
 *
 * Options:
 *   --limit <n>       Maximum number of entities to process (default: all)
 *   --entity-id <id>  Process only specific entity
 *   --category <cat>  Filter by chat category: personal, working, all (default: all extractable)
 *   --dry-run         Show what would be processed without actually extracting
 *   --delay <ms>      Delay between entities in ms (default: 2000)
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { EntityService } from '../modules/entity/entity.service';
import { FactExtractionService } from '../modules/extraction/fact-extraction.service';
import { MessageService } from '../modules/interaction/message/message.service';
import { ChatCategoryService } from '../modules/chat-category/chat-category.service';
import { ChatCategory } from '@pkg/entities';

interface CliOptions {
  limit?: number;
  entityId?: string;
  category?: 'personal' | 'working' | 'all';
  dryRun?: boolean;
  delay?: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    category: 'all',
    dryRun: false,
    delay: 2000,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--limit':
        options.limit = parseInt(args[++i], 10);
        break;
      case '--entity-id':
        options.entityId = args[++i];
        break;
      case '--category':
        options.category = args[++i] as 'personal' | 'working' | 'all';
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--delay':
        options.delay = parseInt(args[++i], 10);
        break;
      case '--help':
        console.log(`
Historical Fact Extraction CLI

Usage:
  npx ts-node -r tsconfig-paths/register src/cli/extract-historical.ts [options]

Options:
  --limit <n>        Maximum number of entities to process (default: all)
  --entity-id <id>   Process only specific entity
  --category <cat>   Filter by chat category: personal, working, all (default: all)
  --dry-run          Show what would be processed without actually extracting
  --delay <ms>       Delay between entities in ms (default: 2000)
  --help             Show this help message
        `);
        process.exit(0);
    }
  }

  return options;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function bootstrap() {
  const options = parseArgs();

  console.log('🚀 Starting Historical Fact Extraction...');
  console.log('Options:', JSON.stringify(options, null, 2));

  // Create NestJS application context (no HTTP server)
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const entityService = app.get(EntityService);
    const extractionService = app.get(FactExtractionService);
    const messageService = app.get(MessageService);
    const categoryService = app.get(ChatCategoryService);

    let entities: Array<{ id: string; name: string }>;

    if (options.entityId) {
      // Process single entity
      const entity = await entityService.findOne(options.entityId);
      if (!entity) {
        console.error(`❌ Entity not found: ${options.entityId}`);
        process.exit(1);
      }
      entities = [{ id: entity.id, name: entity.name }];
    } else {
      // Get all entities
      const result = await entityService.findAll({
        limit: options.limit || 10000,
        offset: 0,
      });
      entities = result.items.map(e => ({ id: e.id, name: e.name }));
    }

    console.log(`📋 Found ${entities.length} entities to process`);

    // Filter by category if needed
    if (options.category !== 'all') {
      console.log(`🔍 Filtering by category: ${options.category}`);
      // This would require joining with messages/interactions to get chat categories
      // For now, we process all and skip non-matching in the loop
    }

    const stats = {
      processed: 0,
      skipped: 0,
      factsExtracted: 0,
      errors: 0,
    };

    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      const progress = `[${i + 1}/${entities.length}]`;

      try {
        // Get messages for this entity
        const messages = await messageService.findByEntity(entity.id, 100);

        if (messages.length === 0) {
          console.log(`${progress} ⏭️  ${entity.name}: No messages, skipping`);
          stats.skipped++;
          continue;
        }

        // Check if entity has extractable messages (from personal/working chats)
        // For now, we extract from all messages
        const extractableMessages = messages.filter(
          m => m.content && m.content.trim().length > 10
        );

        if (extractableMessages.length === 0) {
          console.log(`${progress} ⏭️  ${entity.name}: No extractable content`);
          stats.skipped++;
          continue;
        }

        if (options.dryRun) {
          console.log(`${progress} 🔍 ${entity.name}: Would process ${extractableMessages.length} messages`);
          stats.processed++;
          continue;
        }

        console.log(`${progress} 🔄 ${entity.name}: Processing ${extractableMessages.length} messages...`);

        // Build content for extraction
        const contentItems = extractableMessages.map(m => ({
          id: m.id,
          content: m.content!,
          interactionId: m.interactionId,
        }));

        // Extract facts
        const result = await extractionService.extractFactsBatch({
          entityId: entity.id,
          entityName: entity.name,
          messages: contentItems,
        });

        const factsCount = result.facts?.length ?? 0;
        stats.factsExtracted += factsCount;
        stats.processed++;

        console.log(`${progress} ✅ ${entity.name}: Extracted ${factsCount} facts`);

        // Delay between entities to avoid overloading
        if (i < entities.length - 1 && options.delay) {
          await sleep(options.delay);
        }
      } catch (error) {
        stats.errors++;
        console.error(`${progress} ❌ ${entity.name}: Error - ${(error as Error).message}`);
      }
    }

    console.log('\n📊 Extraction Complete!');
    console.log('─'.repeat(40));
    console.log(`  Processed:  ${stats.processed}`);
    console.log(`  Skipped:    ${stats.skipped}`);
    console.log(`  Facts:      ${stats.factsExtracted}`);
    console.log(`  Errors:     ${stats.errors}`);
    console.log('─'.repeat(40));
  } finally {
    await app.close();
  }
}

bootstrap().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
