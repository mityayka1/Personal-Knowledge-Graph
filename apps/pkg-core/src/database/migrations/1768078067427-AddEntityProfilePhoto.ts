import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEntityProfilePhoto1768078067427 implements MigrationInterface {
  name = 'AddEntityProfilePhoto1768078067427';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add profile_photo column to entities table
    await queryRunner.query(`ALTER TABLE "entities" ADD "profile_photo" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "entities" DROP COLUMN IF EXISTS "profile_photo"`);
  }
}
