import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';

describe('Agent Endpoints (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  const testPrefix = `agent_e2e_${Date.now()}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();

    dataSource = moduleFixture.get(DataSource);
  }, 30000);

  afterAll(async () => {
    await cleanupTestData();
    await app.close();
  });

  async function cleanupTestData() {
    try {
      await dataSource.query(`
        DELETE FROM entities WHERE name LIKE '${testPrefix}%';
      `);
    } catch (e) {
      console.warn('Cleanup warning:', (e as Error).message);
    }
  }

  describe('POST /agent/recall', () => {
    it('should accept valid recall request and return structured response', async () => {
      const response = await request(app.getHttpServer())
        .post('/agent/recall')
        .send({ query: 'тестовый поиск информации' })
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('data');
      expect(response.body.data).toHaveProperty('answer');
      expect(response.body.data).toHaveProperty('sources');
      expect(response.body.data).toHaveProperty('toolsUsed');
      expect(Array.isArray(response.body.data.sources)).toBe(true);
      expect(Array.isArray(response.body.data.toolsUsed)).toBe(true);
    }, 90000);

    it('should reject query shorter than 3 characters', async () => {
      const response = await request(app.getHttpServer())
        .post('/agent/recall')
        .send({ query: 'ab' })
        .expect(400);

      expect(response.body).toHaveProperty('message');
    });

    it('should handle empty result gracefully with limited turns', async () => {
      const response = await request(app.getHttpServer())
        .post('/agent/recall')
        .send({
          query: 'xyznonexistent_query_12345_that_wont_match_anything',
          maxTurns: 5,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.answer).toBeDefined();
    }, 90000);

    it('should accept entityId filter parameter', async () => {
      // Create test entity first
      const entityResponse = await request(app.getHttpServer())
        .post('/entities')
        .send({
          type: 'person',
          name: `${testPrefix}_filter_test`,
        })
        .expect(201);

      const entityId = entityResponse.body.id;

      const response = await request(app.getHttpServer())
        .post('/agent/recall')
        .send({
          query: 'тестовый запрос с фильтром по контакту',
          entityId,
          maxTurns: 5,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
    }, 90000);

    it('should reject invalid UUID for entityId', async () => {
      await request(app.getHttpServer())
        .post('/agent/recall')
        .send({
          query: 'тестовый запрос',
          entityId: 'not-a-valid-uuid',
        })
        .expect(400);
    });

    it('should respect maxTurns parameter boundaries', async () => {
      // maxTurns exceeding max (should fail validation)
      await request(app.getHttpServer())
        .post('/agent/recall')
        .send({
          query: 'простой тест',
          maxTurns: 100,
        })
        .expect(400);
    });
  });

  describe('GET /agent/prepare/:entityId', () => {
    it('should return briefing for existing entity', async () => {
      // Create test entity
      const entityResponse = await request(app.getHttpServer())
        .post('/entities')
        .send({
          type: 'person',
          name: `${testPrefix}_prepare_test`,
          notes: 'Тестовые заметки о контакте для проверки prepare',
        })
        .expect(201);

      const entityId = entityResponse.body.id;

      const response = await request(app.getHttpServer())
        .get(`/agent/prepare/${entityId}`)
        .expect(200);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body.data).toHaveProperty('entityId', entityId);
      expect(response.body.data).toHaveProperty('entityName');
      expect(response.body.data).toHaveProperty('brief');
      expect(response.body.data).toHaveProperty('recentInteractions');
      expect(response.body.data).toHaveProperty('openQuestions');
      expect(Array.isArray(response.body.data.openQuestions)).toBe(true);
    }, 90000);

    it('should return 404 for non-existent entity', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';

      await request(app.getHttpServer())
        .get(`/agent/prepare/${fakeId}`)
        .expect(404);
    });

    it('should return 400 for invalid UUID format', async () => {
      await request(app.getHttpServer())
        .get('/agent/prepare/not-a-uuid')
        .expect(400);
    });

    it('should handle entity without any messages', async () => {
      // Create entity without messages
      const entityResponse = await request(app.getHttpServer())
        .post('/entities')
        .send({
          type: 'person',
          name: `${testPrefix}_no_messages`,
        })
        .expect(201);

      const response = await request(app.getHttpServer())
        .get(`/agent/prepare/${entityResponse.body.id}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.brief).toBeDefined();
    }, 90000);
  });
});
