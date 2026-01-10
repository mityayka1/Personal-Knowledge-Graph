import { Controller, Post, Body, Param, Get, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { FactExtractionService } from './fact-extraction.service';
import { MessageService } from '../interaction/message/message.service';
import { EntityService } from '../entity/entity.service';

interface ExtractFactsDto {
  entityId: string;
  entityName: string;
  messageContent: string;
  messageId?: string;
  interactionId?: string;
}

@Controller('extraction')
export class ExtractionController {
  constructor(
    private extractionService: FactExtractionService,
    @Inject(forwardRef(() => MessageService))
    private messageService: MessageService,
    @Inject(forwardRef(() => EntityService))
    private entityService: EntityService,
  ) {}

  @Post('facts')
  async extractFacts(@Body() dto: ExtractFactsDto) {
    return this.extractionService.extractFacts(dto);
  }

  /**
   * Extract facts from entity's message history and notes
   * GET /extraction/entity/:entityId/facts
   */
  @Get('entity/:entityId/facts')
  async extractFactsFromHistory(@Param('entityId') entityId: string) {
    // 1. Get entity
    const entity = await this.entityService.findOne(entityId);
    if (!entity) {
      throw new NotFoundException(`Entity ${entityId} not found`);
    }

    // 2. Get messages from this entity
    const messages = await this.messageService.findByEntity(entityId, 50);

    // 3. Build content array: notes (if any) + messages
    const contentItems: Array<{ id: string; content: string; interactionId?: string }> = [];

    // Always include notes if present (as first item for priority)
    if (entity.notes && entity.notes.trim().length > 10) {
      contentItems.push({
        id: 'notes',
        content: `[ЗАМЕТКИ О КОНТАКТЕ]: ${entity.notes}`,
      });
    }

    // Add messages with content
    const messagesWithContent = messages
      .filter(m => m.content && m.content.trim().length > 10)
      .map(m => ({
        id: m.id,
        content: m.content!,
        interactionId: m.interactionId,
      }));

    contentItems.push(...messagesWithContent);

    // No extractable content at all
    if (contentItems.length === 0) {
      return {
        entityId,
        entityName: entity.name,
        facts: [],
        messageCount: 0,
        message: 'No messages or notes found for this entity',
      };
    }

    // 4. Extract facts using batch method
    const result = await this.extractionService.extractFactsBatch({
      entityId,
      entityName: entity.name,
      messages: contentItems,
    });

    return {
      ...result,
      entityName: entity.name,
      messageCount: messagesWithContent.length,
      hasNotes: !!(entity.notes && entity.notes.trim().length > 10),
    };
  }
}
