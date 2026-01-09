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
   * Extract facts from entity's message history
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

    // If no messages, try to extract from entity notes
    if (messages.length === 0) {
      if (entity.notes && entity.notes.trim().length > 10) {
        const result = await this.extractionService.extractFacts({
          entityId,
          entityName: entity.name,
          messageContent: entity.notes,
        });
        return {
          ...result,
          entityName: entity.name,
          messageCount: 0,
          source: 'notes',
        };
      }
      return {
        entityId,
        entityName: entity.name,
        facts: [],
        messageCount: 0,
        message: 'No messages or notes found for this entity',
      };
    }

    // 3. Extract facts using batch method
    const messagesWithContent = messages
      .filter(m => m.content && m.content.trim().length > 10)
      .map(m => ({
        id: m.id,
        content: m.content!,
        interactionId: m.interactionId,
      }));

    if (messagesWithContent.length === 0) {
      return {
        entityId,
        entityName: entity.name,
        facts: [],
        messageCount: messages.length,
        message: 'No messages with extractable content',
      };
    }

    const result = await this.extractionService.extractFactsBatch({
      entityId,
      entityName: entity.name,
      messages: messagesWithContent,
    });

    return {
      ...result,
      entityName: entity.name,
      messageCount: messagesWithContent.length,
    };
  }
}
