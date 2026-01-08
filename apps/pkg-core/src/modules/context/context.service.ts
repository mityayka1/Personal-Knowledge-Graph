import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityService } from '../entity/entity.service';
import { ContextRequest, ContextResponse } from '@pkg/shared';

@Injectable()
export class ContextService {
  constructor(
    private configService: ConfigService,
    private entityService: EntityService,
  ) {}

  async generateContext(request: ContextRequest): Promise<ContextResponse> {
    const entity = await this.entityService.findOne(request.entityId);

    // Build context markdown
    const sections: string[] = [];

    // Header
    sections.push(`## Контекст: ${entity.name}`);
    sections.push('');

    // Basic info
    sections.push(`**Тип:** ${entity.type}`);
    if (entity.organization) {
      sections.push(`**Организация:** ${entity.organization.name}`);
    }
    if (entity.notes) {
      sections.push(`**Заметки:** ${entity.notes}`);
    }
    sections.push('');

    // Facts
    if (entity.facts?.length) {
      sections.push('### Факты');
      entity.facts.forEach(fact => {
        const value = fact.valueDate
          ? new Date(fact.valueDate).toLocaleDateString('ru-RU')
          : fact.value;
        sections.push(`- **${fact.factType}:** ${value}`);
      });
      sections.push('');
    }

    // Identifiers
    if (entity.identifiers?.length) {
      sections.push('### Контакты');
      entity.identifiers.forEach(ident => {
        sections.push(`- **${ident.identifierType}:** ${ident.identifierValue}`);
      });
      sections.push('');
    }

    const contextMarkdown = sections.join('\n');

    return {
      entityId: entity.id,
      entityName: entity.name,
      contextMarkdown,
      tokenCount: Math.ceil(contextMarkdown.length / 4), // Rough estimate
      sources: {
        interactionsUsed: 0,
        messagesAnalyzed: 0,
        factsIncluded: entity.facts?.length || 0,
      },
      generatedAt: new Date().toISOString(),
    };
  }
}
