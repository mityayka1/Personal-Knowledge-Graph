import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env.test before tests
dotenv.config({
  path: path.resolve(__dirname, '../.env.test'),
});
