import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';

describe('Extraction Flow (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  // Unique prefix for this test run
  const testPrefix = `extract_${Date.now()}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();

    dataSource = moduleFixture.get(DataSource);
  });

  afterAll(async () => {
    await cleanupTestData();
    await app.close();
  });

  async function cleanupTestData() {
    try {
      await dataSource.query(`
        DELETE FROM entity_events WHERE source_quote LIKE '${testPrefix}%';
        DELETE FROM entity_facts WHERE source = 'extracted' AND created_at > NOW() - INTERVAL '1 hour';
        DELETE FROM pending_facts WHERE created_at > NOW() - INTERVAL '1 hour';
        DELETE FROM messages WHERE telegram_chat_id LIKE '${testPrefix}%';
        DELETE FROM chat_categories WHERE telegram_chat_id LIKE '${testPrefix}%';
        DELETE FROM entity_identifiers WHERE identifier_value LIKE '${testPrefix}%';
        DELETE FROM entities WHERE name LIKE '${testPrefix}%';
        DELETE FROM interactions WHERE source_chat_id LIKE '${testPrefix}%';
      `);
    } catch (e) {
      console.warn('Cleanup warning:', (e as Error).message);
    }
  }

  describe('POST /extraction/facts', () => {
    it('should accept extraction request and return result', async () => {
      // Create entity first
      const entityResponse = await request(app.getHttpServer())
        .post('/entities')
        .send({
          type: 'person',
          name: `${testPrefix}_person`,
        })
        .expect(201);

      const entityId = entityResponse.body.id;

      // Call extraction endpoint
      const response = await request(app.getHttpServer())
        .post('/extraction/facts')
        .send({
          entityId,
          entityName: `${testPrefix}_person`,
          messageContent: 'Я работаю в компании Google как инженер-программист. Мой день рождения 15 марта.',
        });

      // Should not fail (200 or 201)
      expect([200, 201]).toContain(response.status);
      expect(response.body).toBeDefined();
    }, 60000); // Longer timeout for LLM call

    it('should handle empty message gracefully', async () => {
      const entityResponse = await request(app.getHttpServer())
        .post('/entities')
        .send({
          type: 'person',
          name: `${testPrefix}_empty`,
        })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post('/extraction/facts')
        .send({
          entityId: entityResponse.body.id,
          entityName: `${testPrefix}_empty`,
          messageContent: '',
        });

      // Should handle gracefully
      expect([200, 201, 400]).toContain(response.status);
    });
  });

  describe('GET /extraction/entity/:entityId/facts', () => {
    it('should return 404 for non-existent entity', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';

      await request(app.getHttpServer())
        .get(`/extraction/entity/${fakeId}/facts`)
        .expect(404);
    });

    it('should return empty facts for entity without messages', async () => {
      // Create entity without messages
      const entityResponse = await request(app.getHttpServer())
        .post('/entities')
        .send({
          type: 'person',
          name: `${testPrefix}_no_messages`,
        })
        .expect(201);

      const response = await request(app.getHttpServer())
        .get(`/extraction/entity/${entityResponse.body.id}/facts`)
        .expect(200);

      expect(response.body).toHaveProperty('facts');
      expect(response.body.facts).toEqual([]);
      expect(response.body.message).toContain('No messages');
    });

    it('should extract facts from entity with messages', async () => {
      const chatId = `${testPrefix}_with_messages_${Date.now()}`;
      const userId = `${testPrefix}_user_${Date.now()}`;

      // Create message (which creates entity via resolution)
      const messageDto = {
        source: `${testPrefix}_telegram`,
        telegram_chat_id: chatId,
        telegram_user_id: userId,
        telegram_display_name: `${testPrefix}_Test User`,
        message_id: `msg_${Date.now()}`,
        text: 'Привет! Я работаю в Яндексе как продакт-менеджер. Мой телефон +7 999 123 4567.',
        timestamp: new Date().toISOString(),
        is_outgoing: false,
        chat_type: 'private',
        participants_count: 2,
      };

      const messageResponse = await request(app.getHttpServer())
        .post('/messages')
        .send(messageDto)
        .expect(201);

      const entityId = messageResponse.body.entity_id;

      // Entity should be auto-created for personal chat
      expect(entityId).toBeDefined();

      // Call extraction
      const response = await request(app.getHttpServer())
        .get(`/extraction/entity/${entityId}/facts`)
        .expect(200);

      expect(response.body).toHaveProperty('entityId', entityId);
      expect(response.body).toHaveProperty('messageCount');
      expect(response.body.messageCount).toBeGreaterThan(0);
    }, 60000);

    it('should include notes in extraction when present', async () => {
      // Create entity with notes
      const entityResponse = await request(app.getHttpServer())
        .post('/entities')
        .send({
          type: 'person',
          name: `${testPrefix}_with_notes`,
          notes: 'Это важный клиент из компании Microsoft. День рождения 10 июня. Любит гольф.',
        })
        .expect(201);

      const response = await request(app.getHttpServer())
        .get(`/extraction/entity/${entityResponse.body.id}/facts`)
        .expect(200);

      expect(response.body).toHaveProperty('hasNotes', true);
    }, 60000);
  });

  describe('Entity Events Extraction', () => {
    it('should list entity_events endpoint', async () => {
      // Create entity first
      const entityResponse = await request(app.getHttpServer())
        .post('/entities')
        .send({
          type: 'person',
          name: `${testPrefix}_events_test`,
        })
        .expect(201);

      const entityId = entityResponse.body.id;

      // Check entity-events endpoint exists with entity_id query param
      const response = await request(app.getHttpServer())
        .get('/entity-events')
        .query({ entity_id: entityId })
        .expect(200);

      expect(response.body).toHaveProperty('items');
    });

    it('should list events with pagination', async () => {
      const entityResponse = await request(app.getHttpServer())
        .post('/entities')
        .send({
          type: 'person',
          name: `${testPrefix}_events_pagination`,
        })
        .expect(201);

      const response = await request(app.getHttpServer())
        .get('/entity-events')
        .query({ entity_id: entityResponse.body.id, limit: 10, offset: 0 })
        .expect(200);

      expect(response.body).toHaveProperty('items');
      expect(response.body).toHaveProperty('total');
    });
  });

  describe('Pending Facts Flow', () => {
    it('should have pending-facts endpoint', async () => {
      const response = await request(app.getHttpServer())
        .get('/pending-facts')
        .expect(200);

      expect(response.body).toBeDefined();
      expect(response.body).toHaveProperty('items');
    });

    it('should filter pending-facts by status', async () => {
      const response = await request(app.getHttpServer())
        .get('/pending-facts')
        .query({ status: 'pending' })
        .expect(200);

      expect(response.body).toHaveProperty('items');
      // All returned items should have pending status
      if (response.body.items.length > 0) {
        response.body.items.forEach((item: any) => {
          expect(item.status).toBe('pending');
        });
      }
    });
  });

  describe('Full Extraction Pipeline', () => {
    it('should handle complete flow: message -> entity -> extraction', async () => {
      const chatId = `${testPrefix}_full_flow_${Date.now()}`;
      const userId = `${testPrefix}_user_full_${Date.now()}`;

      // Step 1: Create message (triggers entity creation)
      const messageDto = {
        source: `${testPrefix}_telegram`,
        telegram_chat_id: chatId,
        telegram_user_id: userId,
        telegram_display_name: `${testPrefix}_Full Test User`,
        message_id: `msg_full_${Date.now()}`,
        text: 'Работаю руководителем отдела в Сбербанке. Живу в Москве на Тверской. Завтра в 15:00 созвонимся.',
        timestamp: new Date().toISOString(),
        is_outgoing: false,
        chat_type: 'private',
        participants_count: 2,
      };

      const messageResponse = await request(app.getHttpServer())
        .post('/messages')
        .send(messageDto)
        .expect(201);

      expect(messageResponse.body.entity_id).toBeDefined();
      expect(messageResponse.body.chat_category).toBe('personal');

      const entityId = messageResponse.body.entity_id;

      // Step 2: Verify entity was created
      const entityResponse = await request(app.getHttpServer())
        .get(`/entities/${entityId}`)
        .expect(200);

      expect(entityResponse.body.id).toBe(entityId);

      // Step 3: Check extraction can be triggered
      const extractResponse = await request(app.getHttpServer())
        .get(`/extraction/entity/${entityId}/facts`);

      expect([200, 201]).toContain(extractResponse.status);
      expect(extractResponse.body.entityId).toBe(entityId);
      expect(extractResponse.body.messageCount).toBeGreaterThan(0);
    }, 90000); // Extra long timeout for full pipeline
  });
});
