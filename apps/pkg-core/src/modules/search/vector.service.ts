import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message } from '@pkg/entities';
import { SearchResult } from '@pkg/shared';

@Injectable()
export class VectorService {
  constructor(
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
  ) {}

  async search(
    embedding: number[],
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
        (m.embedding <=> $1::vector) as distance
      FROM messages m
      LEFT JOIN entities e ON m.sender_entity_id = e.id
      WHERE m.embedding IS NOT NULL
    `;

    const params: any[] = [JSON.stringify(embedding)];
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

    sql += ` ORDER BY m.embedding <=> $1::vector LIMIT $${paramIndex}`;
    params.push(limit);

    const results = await this.messageRepo.query(sql, params);

    return results.map((r: any) => ({
      type: 'message' as const,
      id: r.id,
      content: r.content,
      timestamp: r.timestamp,
      entity: r.sender_entity_id ? { id: r.sender_entity_id, name: r.entity_name } : undefined,
      interactionId: r.interaction_id,
      score: 1 - parseFloat(r.distance), // Convert distance to similarity
    }));
  }
}
