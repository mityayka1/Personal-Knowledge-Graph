import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env.test before tests
dotenv.config({
  path: path.resolve(__dirname, '../.env.test'),
});

// Export API key for tests to use in headers
export const API_KEY = process.env.API_KEY || 'test-api-key';

// Helper to create authenticated request
import request from 'supertest';

export function authRequest(app: any) {
  const agent = request.agent(app);
  return {
    get: (url: string) => agent.get(url).set('x-api-key', API_KEY),
    post: (url: string) => agent.post(url).set('x-api-key', API_KEY),
    put: (url: string) => agent.put(url).set('x-api-key', API_KEY),
    patch: (url: string) => agent.patch(url).set('x-api-key', API_KEY),
    delete: (url: string) => agent.delete(url).set('x-api-key', API_KEY),
  };
}
