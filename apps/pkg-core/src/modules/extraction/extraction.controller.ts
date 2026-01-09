import { Controller, Post, Body } from '@nestjs/common';
import { FactExtractionService } from './fact-extraction.service';

interface ExtractFactsDto {
  entityId: string;
  entityName: string;
  messageContent: string;
  messageId?: string;
  interactionId?: string;
}

@Controller('extraction')
export class ExtractionController {
  constructor(private extractionService: FactExtractionService) {}

  @Post('facts')
  async extractFacts(@Body() dto: ExtractFactsDto) {
    return this.extractionService.extractFacts(dto);
  }
}
