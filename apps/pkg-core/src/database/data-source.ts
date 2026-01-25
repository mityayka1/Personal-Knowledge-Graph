import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import * as path from 'path';

// Load .env file for CLI commands
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config();
} catch {
  // dotenv not available, use environment variables directly
}

// Single source of truth for entities
import { ALL_ENTITIES } from './entities';

// Database configuration for TypeORM CLI
// Load from environment variables with fallbacks for development

const getEnvVar = (key: string, fallback?: string): string => {
  const value = process.env[key] || fallback;
  if (!value) {
    throw new Error(`Environment variable ${key} is required`);
  }
  return value;
};

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: getEnvVar('DB_HOST', 'localhost'),
  port: parseInt(getEnvVar('DB_PORT', '5432'), 10),
  username: getEnvVar('DB_USERNAME', 'pkg'),
  password: getEnvVar('DB_PASSWORD', 'pkg_password'),
  database: getEnvVar('DB_DATABASE', 'pkg'),

  // SSL for production
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,

  // Entities from single source of truth
  entities: [...ALL_ENTITIES],

  // Migrations
  migrations: [path.join(__dirname, 'migrations', '*{.ts,.js}')],

  // NEVER use synchronize in production!
  synchronize: false,

  // Logging
  logging: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],

  // Migration settings
  migrationsRun: false,
  migrationsTableName: 'typeorm_migrations',
};

// DataSource instance for CLI
const AppDataSource = new DataSource(dataSourceOptions);

export default AppDataSource;
