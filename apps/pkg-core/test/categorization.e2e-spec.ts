import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ChatCategory } from '@pkg/entities';

describe('Chat Categorization (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  // Unique prefix for this test run to avoid conflicts
  const testPrefix = `test_${Date.now()}`;

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
    // Cleanup test data
    await cleanupTestData();
    await app.close();
  });

  async function cleanupTestData() {
    try {
      await dataSource.query(`
        DELETE FROM messages WHERE source LIKE '${testPrefix}%';
        DELETE FROM chat_categories WHERE telegram_chat_id LIKE '${testPrefix}%';
        DELETE FROM interactions WHERE source_chat_id LIKE '${testPrefix}%';
      `);
    } catch (e) {
      console.warn('Cleanup warning:', (e as Error).message);
    }
  }

  function createMessageDto(overrides: Record<string, any> = {}) {
    return {
      source: `${testPrefix}_telegram`,
      telegram_chat_id: `${testPrefix}_chat_${Date.now()}`,
      telegram_user_id: `${testPrefix}_user_${Date.now()}`,
      telegram_display_name: 'Test User',
      message_id: `msg_${Date.now()}`,
      text: 'Test message content',
      timestamp: new Date().toISOString(),
      is_outgoing: false,
      chat_type: 'private',
      participants_count: 2,
      ...overrides,
    };
  }

  describe('POST /messages - Chat Categorization', () => {
    it('should categorize private chat as PERSONAL', async () => {
      const chatId = `${testPrefix}_private_${Date.now()}`;
      const dto = createMessageDto({
        telegram_chat_id: chatId,
        chat_type: 'private',
        participants_count: 2,
      });

      const response = await request(app.getHttpServer())
        .post('/messages')
        .send(dto)
        .expect(201);

      expect(response.body).toBeDefined();
      expect(response.body.id).toBeDefined();

      // Verify category was created
      const categoryResponse = await request(app.getHttpServer())
        .get(`/chat-categories/${chatId}`)
        .expect(200);

      expect(categoryResponse.body.category).toBe(ChatCategory.PERSONAL);
    });

    it('should categorize small group (<=20) as WORKING', async () => {
      const chatId = `${testPrefix}_small_group_${Date.now()}`;
      const dto = createMessageDto({
        telegram_chat_id: chatId,
        chat_type: 'group',
        participants_count: 10,
      });

      await request(app.getHttpServer())
        .post('/messages')
        .send(dto)
        .expect(201);

      const categoryResponse = await request(app.getHttpServer())
        .get(`/chat-categories/${chatId}`)
        .expect(200);

      expect(categoryResponse.body.category).toBe(ChatCategory.WORKING);
    });

    it('should categorize group at threshold (20) as WORKING', async () => {
      const chatId = `${testPrefix}_threshold_${Date.now()}`;
      const dto = createMessageDto({
        telegram_chat_id: chatId,
        chat_type: 'group',
        participants_count: 20,
      });

      await request(app.getHttpServer())
        .post('/messages')
        .send(dto)
        .expect(201);

      const categoryResponse = await request(app.getHttpServer())
        .get(`/chat-categories/${chatId}`)
        .expect(200);

      expect(categoryResponse.body.category).toBe(ChatCategory.WORKING);
    });

    it('should categorize large group (>20) as MASS', async () => {
      const chatId = `${testPrefix}_large_group_${Date.now()}`;
      const dto = createMessageDto({
        telegram_chat_id: chatId,
        chat_type: 'supergroup',
        participants_count: 100,
      });

      await request(app.getHttpServer())
        .post('/messages')
        .send(dto)
        .expect(201);

      const categoryResponse = await request(app.getHttpServer())
        .get(`/chat-categories/${chatId}`)
        .expect(200);

      expect(categoryResponse.body.category).toBe(ChatCategory.MASS);
    });

    it('should categorize group just above threshold (21) as MASS', async () => {
      const chatId = `${testPrefix}_above_threshold_${Date.now()}`;
      const dto = createMessageDto({
        telegram_chat_id: chatId,
        chat_type: 'group',
        participants_count: 21,
      });

      await request(app.getHttpServer())
        .post('/messages')
        .send(dto)
        .expect(201);

      const categoryResponse = await request(app.getHttpServer())
        .get(`/chat-categories/${chatId}`)
        .expect(200);

      expect(categoryResponse.body.category).toBe(ChatCategory.MASS);
    });

    it('should default to MASS for groups with unknown participant count', async () => {
      const chatId = `${testPrefix}_unknown_count_${Date.now()}`;
      const dto: Record<string, any> = createMessageDto({
        telegram_chat_id: chatId,
        chat_type: 'group',
      });
      delete dto.participants_count;

      await request(app.getHttpServer())
        .post('/messages')
        .send(dto)
        .expect(201);

      const categoryResponse = await request(app.getHttpServer())
        .get(`/chat-categories/${chatId}`)
        .expect(200);

      expect(categoryResponse.body.category).toBe(ChatCategory.MASS);
    });

    it('should categorize channel as MASS', async () => {
      const chatId = `${testPrefix}_channel_${Date.now()}`;
      const dto = createMessageDto({
        telegram_chat_id: chatId,
        chat_type: 'channel',
        participants_count: 1000,
      });

      await request(app.getHttpServer())
        .post('/messages')
        .send(dto)
        .expect(201);

      const categoryResponse = await request(app.getHttpServer())
        .get(`/chat-categories/${chatId}`)
        .expect(200);

      expect(categoryResponse.body.category).toBe(ChatCategory.MASS);
    });

    it('should categorize forum as MASS when large', async () => {
      const chatId = `${testPrefix}_forum_${Date.now()}`;
      const dto = createMessageDto({
        telegram_chat_id: chatId,
        chat_type: 'forum',
        participants_count: 500,
        topic_id: 123,
        topic_name: 'General',
      });

      await request(app.getHttpServer())
        .post('/messages')
        .send(dto)
        .expect(201);

      const categoryResponse = await request(app.getHttpServer())
        .get(`/chat-categories/${chatId}`)
        .expect(200);

      expect(categoryResponse.body.category).toBe(ChatCategory.MASS);
    });

    it('should categorize small forum as WORKING', async () => {
      const chatId = `${testPrefix}_small_forum_${Date.now()}`;
      const dto = createMessageDto({
        telegram_chat_id: chatId,
        chat_type: 'forum',
        participants_count: 5,
        topic_id: 456,
        topic_name: 'Support',
      });

      await request(app.getHttpServer())
        .post('/messages')
        .send(dto)
        .expect(201);

      const categoryResponse = await request(app.getHttpServer())
        .get(`/chat-categories/${chatId}`)
        .expect(200);

      expect(categoryResponse.body.category).toBe(ChatCategory.WORKING);
    });
  });

  describe('Category Persistence', () => {
    it('should keep existing category on subsequent messages', async () => {
      const chatId = `${testPrefix}_persist_${Date.now()}`;

      // First message - creates category as PERSONAL
      const dto1 = createMessageDto({
        telegram_chat_id: chatId,
        message_id: `msg_persist_1_${Date.now()}`,
        chat_type: 'private',
        participants_count: 2,
      });

      await request(app.getHttpServer())
        .post('/messages')
        .send(dto1)
        .expect(201);

      let categoryResponse = await request(app.getHttpServer())
        .get(`/chat-categories/${chatId}`)
        .expect(200);

      expect(categoryResponse.body.category).toBe(ChatCategory.PERSONAL);

      // Second message - category should remain PERSONAL
      const dto2 = createMessageDto({
        telegram_chat_id: chatId,
        message_id: `msg_persist_2_${Date.now()}`,
        text: 'Second message',
        chat_type: 'private',
        participants_count: 2,
      });

      await request(app.getHttpServer())
        .post('/messages')
        .send(dto2)
        .expect(201);

      categoryResponse = await request(app.getHttpServer())
        .get(`/chat-categories/${chatId}`)
        .expect(200);

      expect(categoryResponse.body.category).toBe(ChatCategory.PERSONAL);
    });
  });

  describe('GET /chat-categories', () => {
    beforeAll(async () => {
      // Create a few test categories for listing
      const categories = [
        { type: 'private', count: 2, suffix: 'list_1' },
        { type: 'group', count: 10, suffix: 'list_2' },
        { type: 'supergroup', count: 100, suffix: 'list_3' },
      ];

      for (const cat of categories) {
        const dto = createMessageDto({
          telegram_chat_id: `${testPrefix}_${cat.suffix}_${Date.now()}`,
          chat_type: cat.type,
          participants_count: cat.count,
        });
        await request(app.getHttpServer())
          .post('/messages')
          .send(dto);
      }
    });

    it('should return chat categories list', async () => {
      const response = await request(app.getHttpServer())
        .get('/chat-categories')
        .expect(200);

      expect(response.body).toBeDefined();
      expect(response.body.items || response.body).toBeDefined();
    });

    it('should filter by category', async () => {
      const response = await request(app.getHttpServer())
        .get('/chat-categories')
        .query({ category: ChatCategory.PERSONAL })
        .expect(200);

      const items = response.body.items || response.body;
      if (Array.isArray(items) && items.length > 0) {
        items.forEach((item: any) => {
          expect(item.category).toBe(ChatCategory.PERSONAL);
        });
      }
    });

    it('should support pagination', async () => {
      const response = await request(app.getHttpServer())
        .get('/chat-categories')
        .query({ limit: 2, offset: 0 })
        .expect(200);

      const items = response.body.items || response.body;
      if (Array.isArray(items)) {
        expect(items.length).toBeLessThanOrEqual(2);
      }
    });
  });

  describe('GET /chat-categories/stats', () => {
    it('should return category statistics', async () => {
      const response = await request(app.getHttpServer())
        .get('/chat-categories/stats')
        .expect(200);

      expect(response.body).toHaveProperty('total');
      expect(response.body).toHaveProperty('personal');
      expect(response.body).toHaveProperty('working');
      expect(response.body).toHaveProperty('mass');
      expect(typeof response.body.total).toBe('number');
    });
  });

  describe('GET /chat-categories/:telegramChatId', () => {
    it('should return category for existing chat', async () => {
      const chatId = `${testPrefix}_get_single_${Date.now()}`;
      const dto = createMessageDto({
        telegram_chat_id: chatId,
        chat_type: 'private',
        participants_count: 2,
      });

      await request(app.getHttpServer())
        .post('/messages')
        .send(dto)
        .expect(201);

      const response = await request(app.getHttpServer())
        .get(`/chat-categories/${chatId}`)
        .expect(200);

      expect(response.body.telegramChatId).toBe(chatId);
      expect(response.body.category).toBe(ChatCategory.PERSONAL);
    });

    it('should return found:false for non-existing chat', async () => {
      const response = await request(app.getHttpServer())
        .get(`/chat-categories/non_existing_chat_${Date.now()}`)
        .expect(200);

      expect(response.body.found).toBe(false);
    });
  });
});
