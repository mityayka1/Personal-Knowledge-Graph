import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Queue } from 'bullmq';
import { getQueueToken } from '@nestjs/bullmq';
import { AppModule } from '../src/app.module';
import { ChatCategory } from '@pkg/entities';

describe('Extraction Debouncing (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let extractionQueue: Queue;

  // Unique prefix for this test run to avoid conflicts
  const testPrefix = `debounce_${Date.now()}`;

  // Short delay for tests (5 seconds instead of 10 minutes)
  const TEST_DELAY_MS = 5000;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    extractionQueue = moduleFixture.get<Queue>(getQueueToken('fact-extraction'));

    // Set short delay for tests
    await dataSource.query(`
      INSERT INTO settings (key, value, category, description)
      VALUES ('extraction.extractDelayTime', '${TEST_DELAY_MS}', 'extraction', 'Test delay')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);
  });

  afterAll(async () => {
    // Cleanup test data
    await cleanupTestData();
    await app.close();
  });

  async function cleanupTestData() {
    try {
      // Clean up BullMQ jobs
      const jobs = await extractionQueue.getJobs(['delayed', 'waiting', 'active']);
      for (const job of jobs) {
        if (job.id?.startsWith(`extraction_${testPrefix}`)) {
          await job.remove();
        }
      }

      // Clean up database
      await dataSource.query(`
        DELETE FROM messages WHERE telegram_chat_id LIKE '${testPrefix}%';
        DELETE FROM chat_categories WHERE telegram_chat_id LIKE '${testPrefix}%';
        DELETE FROM interactions WHERE source_chat_id LIKE '${testPrefix}%';
        DELETE FROM settings WHERE key = 'extraction.extractDelayTime' AND value = '${TEST_DELAY_MS}';
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
      message_id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      text: 'Test message content for extraction testing which is sufficiently long to trigger extraction',
      timestamp: new Date().toISOString(),
      is_outgoing: false,
      chat_type: 'private',
      participants_count: 2,
      ...overrides,
    };
  }

  describe('Extraction Job Scheduling', () => {
    it('should create extraction job for personal chat message', async () => {
      const chatId = `${testPrefix}_personal_${Date.now()}`;
      const dto = createMessageDto({
        telegram_chat_id: chatId,
        chat_type: 'private',
        participants_count: 2,
      });

      const response = await request(app.getHttpServer())
        .post('/messages')
        .send(dto)
        .expect(201);

      expect(response.body.chat_category).toBe(ChatCategory.PERSONAL);

      // Wait a bit for async job creation
      await new Promise(r => setTimeout(r, 500));

      // Verify extraction job was created
      const interactionId = response.body.interaction_id;
      const jobId = `extraction_${interactionId}`;
      const job = await extractionQueue.getJob(jobId);

      expect(job).toBeDefined();
      expect(await job?.getState()).toBe('delayed');
      expect(job?.data.messageIds).toHaveLength(1);
      expect(job?.data.interactionId).toBe(interactionId);
    });

    it('should create extraction job for working group message', async () => {
      const chatId = `${testPrefix}_working_${Date.now()}`;
      const dto = createMessageDto({
        telegram_chat_id: chatId,
        chat_type: 'group',
        participants_count: 10,
      });

      const response = await request(app.getHttpServer())
        .post('/messages')
        .send(dto)
        .expect(201);

      expect(response.body.chat_category).toBe(ChatCategory.WORKING);

      await new Promise(r => setTimeout(r, 500));

      const interactionId = response.body.interaction_id;
      const jobId = `extraction_${interactionId}`;
      const job = await extractionQueue.getJob(jobId);

      expect(job).toBeDefined();
      expect(await job?.getState()).toBe('delayed');
    });

    it('should NOT create extraction job for mass chat message', async () => {
      const chatId = `${testPrefix}_mass_${Date.now()}`;
      const dto = createMessageDto({
        telegram_chat_id: chatId,
        chat_type: 'supergroup',
        participants_count: 100,
      });

      const response = await request(app.getHttpServer())
        .post('/messages')
        .send(dto)
        .expect(201);

      expect(response.body.chat_category).toBe(ChatCategory.MASS);

      await new Promise(r => setTimeout(r, 500));

      // Mass chats should not have extraction jobs
      const interactionId = response.body.interaction_id;
      const jobId = `extraction_${interactionId}`;
      const job = await extractionQueue.getJob(jobId);

      expect(job).toBeFalsy();
    });
  });

  describe('Debouncing Behavior', () => {
    it('should accumulate messages in same job when sent within delay period', async () => {
      const chatId = `${testPrefix}_debounce_${Date.now()}`;
      const userId = `${testPrefix}_user_${Date.now()}`;

      // First message
      const dto1 = createMessageDto({
        telegram_chat_id: chatId,
        telegram_user_id: userId,
        message_id: `msg_1_${Date.now()}`,
        text: 'First message about my work at Google as a software engineer',
      });

      const response1 = await request(app.getHttpServer())
        .post('/messages')
        .send(dto1)
        .expect(201);

      const interactionId = response1.body.interaction_id;
      const jobId = `extraction_${interactionId}`;

      await new Promise(r => setTimeout(r, 300));

      // Verify first job created
      let job = await extractionQueue.getJob(jobId);
      expect(job).toBeDefined();
      expect(job?.data.messageIds).toHaveLength(1);
      const initialDelay = job?.delay;

      // Second message (same chat, same interaction)
      const dto2 = createMessageDto({
        telegram_chat_id: chatId,
        telegram_user_id: userId,
        message_id: `msg_2_${Date.now()}`,
        text: 'Second message - I will be moving to a new apartment next week',
      });

      await request(app.getHttpServer())
        .post('/messages')
        .send(dto2)
        .expect(201);

      await new Promise(r => setTimeout(r, 300));

      // Verify job was updated with second message
      job = await extractionQueue.getJob(jobId);
      expect(job).toBeDefined();
      expect(job?.data.messageIds).toHaveLength(2);
      expect(job?.data.messages).toHaveLength(2);

      // Third message
      const dto3 = createMessageDto({
        telegram_chat_id: chatId,
        telegram_user_id: userId,
        message_id: `msg_3_${Date.now()}`,
        text: 'Third message - My birthday is on March 15th by the way',
      });

      await request(app.getHttpServer())
        .post('/messages')
        .send(dto3)
        .expect(201);

      await new Promise(r => setTimeout(r, 300));

      // Verify all 3 messages in same job
      job = await extractionQueue.getJob(jobId);
      expect(job).toBeDefined();
      expect(job?.data.messageIds).toHaveLength(3);
      expect(job?.data.messages).toHaveLength(3);

      // Verify job is still in delayed state
      expect(await job?.getState()).toBe('delayed');
    });

    it('should have message content accumulated in job data', async () => {
      const chatId = `${testPrefix}_content_${Date.now()}`;
      const userId = `${testPrefix}_user_content_${Date.now()}`;

      const messages = [
        'I work at Microsoft as a product manager',
        'My phone number is +7 999 123 4567',
        'Lets meet on Friday at 3pm for coffee',
      ];

      let interactionId: string;

      for (let i = 0; i < messages.length; i++) {
        const dto = createMessageDto({
          telegram_chat_id: chatId,
          telegram_user_id: userId,
          message_id: `msg_${i}_${Date.now()}`,
          text: messages[i],
        });

        const response = await request(app.getHttpServer())
          .post('/messages')
          .send(dto)
          .expect(201);

        if (i === 0) {
          interactionId = response.body.interaction_id;
        }

        await new Promise(r => setTimeout(r, 200));
      }

      const jobId = `extraction_${interactionId!}`;
      const job = await extractionQueue.getJob(jobId);

      expect(job).toBeDefined();
      expect(job?.data.messages).toHaveLength(3);

      // Verify content is preserved
      const contents = job?.data.messages.map((m: any) => m.content);
      expect(contents).toContain(messages[0]);
      expect(contents).toContain(messages[1]);
      expect(contents).toContain(messages[2]);
    });
  });

  describe('Short Message Filtering', () => {
    it('should NOT create extraction job for short messages', async () => {
      const chatId = `${testPrefix}_short_${Date.now()}`;
      const dto = createMessageDto({
        telegram_chat_id: chatId,
        chat_type: 'private',
        text: 'Hi', // Too short for extraction
      });

      const response = await request(app.getHttpServer())
        .post('/messages')
        .send(dto)
        .expect(201);

      await new Promise(r => setTimeout(r, 500));

      const interactionId = response.body.interaction_id;
      const jobId = `extraction_${interactionId}`;
      const job = await extractionQueue.getJob(jobId);

      // Short messages should not trigger extraction
      expect(job).toBeFalsy();
    });

    it('should create extraction job only when message is long enough', async () => {
      const chatId = `${testPrefix}_longshort_${Date.now()}`;
      const userId = `${testPrefix}_user_ls_${Date.now()}`;

      // Short message first - no job
      const dto1 = createMessageDto({
        telegram_chat_id: chatId,
        telegram_user_id: userId,
        message_id: `msg_short_${Date.now()}`,
        text: 'ok',
      });

      const response1 = await request(app.getHttpServer())
        .post('/messages')
        .send(dto1)
        .expect(201);

      const interactionId = response1.body.interaction_id;
      const jobId = `extraction_${interactionId}`;

      await new Promise(r => setTimeout(r, 300));

      let job = await extractionQueue.getJob(jobId);
      expect(job).toBeFalsy();

      // Long message - job created
      const dto2 = createMessageDto({
        telegram_chat_id: chatId,
        telegram_user_id: userId,
        message_id: `msg_long_${Date.now()}`,
        text: 'I will be working from home tomorrow because I have a doctors appointment in the morning',
      });

      await request(app.getHttpServer())
        .post('/messages')
        .send(dto2)
        .expect(201);

      await new Promise(r => setTimeout(r, 300));

      job = await extractionQueue.getJob(jobId);
      expect(job).toBeDefined();
      expect(job?.data.messageIds).toHaveLength(1); // Only long message
    });
  });
});
