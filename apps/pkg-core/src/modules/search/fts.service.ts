import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message } from '@pkg/entities';
import { SearchResult } from '@pkg/shared';

@Injectable()
export class FtsService {
  constructor(
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
  ) {}

  async search(
    query: string,
    entityId?: string,
    period?: { from: string; to: string },
    limit = 20,
  ): Promise<SearchResult[]> {
    let sql = `
      SELECT
        m.id,
        m.content,
        m.timestamp,
        m.interaction_id,
        m.sender_entity_id,
        e.name as entity_name,
        i.type as interaction_type,
        ts_rank(to_tsvector('russian', m.content), plainto_tsquery('russian', $1)) as score,
        ts_headline('russian', m.content, plainto_tsquery('russian', $1), 'MaxFragments=2') as highlight
      FROM messages m
      LEFT JOIN entities e ON m.sender_entity_id = e.id
      LEFT JOIN interactions i ON m.interaction_id = i.id
      WHERE to_tsvector('russian', m.content) @@ plainto_tsquery('russian', $1)
    `;

    const params: any[] = [query];
    let paramIndex = 2;

    if (entityId) {
      sql += ` AND m.sender_entity_id = $${paramIndex}`;
      params.push(entityId);
      paramIndex++;
    }

    if (period?.from) {
      sql += ` AND m.timestamp >= $${paramIndex}`;
      params.push(period.from);
      paramIndex++;
    }

    if (period?.to) {
      sql += ` AND m.timestamp <= $${paramIndex}`;
      params.push(period.to);
      paramIndex++;
    }

    sql += ` ORDER BY score DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const results = await this.messageRepo.query(sql, params);

    // Fetch participants for each unique interaction
    const interactionIds = [...new Set(results.map((r: any) => r.interaction_id))];
    const participantsMap = new Map<string, any[]>();

    if (interactionIds.length > 0) {
      const participantsSql = `
        SELECT
          ip.interaction_id,
          ip.display_name,
          ip.identifier_value,
          ip.entity_id,
          e.name as entity_name
        FROM interaction_participants ip
        LEFT JOIN entities e ON ip.entity_id = e.id
        WHERE ip.interaction_id = ANY($1)
      `;
      const participants = await this.messageRepo.query(participantsSql, [interactionIds]);

      for (const p of participants) {
        const existing = participantsMap.get(p.interaction_id) || [];
        existing.push({
          displayName: p.display_name,
          identifierValue: p.identifier_value,
          entityId: p.entity_id,
          entityName: p.entity_name,
        });
        participantsMap.set(p.interaction_id, existing);
      }
    }

    return results.map((r: any) => ({
      type: 'message' as const,
      id: r.id,
      content: r.content,
      timestamp: r.timestamp,
      entity: r.sender_entity_id ? { id: r.sender_entity_id, name: r.entity_name } : undefined,
      interactionId: r.interaction_id,
      interaction: {
        type: r.interaction_type || 'telegram_session',
        participants: participantsMap.get(r.interaction_id) || [],
      },
      score: parseFloat(r.score),
      highlight: r.highlight,
    }));
  }
}
