import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUsersTable1768300000000 implements MigrationInterface {
  name = 'AddUsersTable1768300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create enum types
    await queryRunner.query(`
      CREATE TYPE user_role AS ENUM ('admin', 'user')
    `);

    await queryRunner.query(`
      CREATE TYPE user_status AS ENUM ('active', 'inactive', 'locked')
    `);

    // Create users table
    await queryRunner.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username VARCHAR(100) NOT NULL UNIQUE,
        email VARCHAR(255) UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(100),
        role user_role NOT NULL DEFAULT 'user',
        status user_status NOT NULL DEFAULT 'active',
        last_login_at TIMESTAMP WITH TIME ZONE,
        failed_login_attempts SMALLINT NOT NULL DEFAULT 0,
        locked_until TIMESTAMP WITH TIME ZONE,
        metadata JSONB,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    await queryRunner.query(`
      CREATE INDEX idx_users_username ON users(username)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX idx_users_status ON users(status)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes
    await queryRunner.query(`DROP INDEX IF EXISTS idx_users_status`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_users_email`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_users_username`);

    // Drop table
    await queryRunner.query(`DROP TABLE IF EXISTS users`);

    // Drop enum types
    await queryRunner.query(`DROP TYPE IF EXISTS user_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS user_role`);
  }
}
