import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1767827005811 implements MigrationInterface {
    name = 'InitialSchema1767827005811'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "entity_identifiers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "entity_id" uuid NOT NULL, "identifier_type" character varying(50) NOT NULL, "identifier_value" character varying(255) NOT NULL, "metadata" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_20ac546eb9c7ec66b8dce6d09f7" UNIQUE ("identifier_type", "identifier_value"), CONSTRAINT "PK_2625b7ecd5d26cf910e9a70a12e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_20ac546eb9c7ec66b8dce6d09f" ON "entity_identifiers" ("identifier_type", "identifier_value") `);
        await queryRunner.query(`CREATE TABLE "interaction_participants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "interaction_id" uuid NOT NULL, "entity_id" uuid, "role" character varying(50) NOT NULL DEFAULT 'participant', "identifier_type" character varying(50) NOT NULL, "identifier_value" character varying(255) NOT NULL, "display_name" character varying(255), CONSTRAINT "UQ_25ad84efa93013ad274a37dd4e2" UNIQUE ("interaction_id", "identifier_type", "identifier_value"), CONSTRAINT "PK_d8031faf03e6401e60809ca49bb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "messages" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "interaction_id" uuid NOT NULL, "sender_entity_id" uuid, "content" text, "is_outgoing" boolean NOT NULL DEFAULT false, "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL, "source_message_id" character varying(100), "reply_to_message_id" uuid, "media_type" character varying(50), "media_url" character varying(500), "embedding" vector(1536), "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_18325f38ae6de43878487eff986" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_99dcff25ef677ca9a24cb4f640" ON "messages" ("interaction_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_41ffb1bd9c518c832d703156d8" ON "messages" ("sender_entity_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_f2113da562ea5bb1ddff44ff60" ON "messages" ("timestamp") `);
        // Note: Vector index should be created manually after data load:
        // CREATE INDEX ON messages USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
        await queryRunner.query(`CREATE TABLE "transcript_segments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "interaction_id" uuid NOT NULL, "speaker_entity_id" uuid, "speaker_label" character varying(50) NOT NULL, "content" text NOT NULL, "start_time" numeric(10,3) NOT NULL, "end_time" numeric(10,3) NOT NULL, "confidence" numeric(3,2), "embedding" vector(1536), "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_34cfd4b54a9857af7dfa443f3ed" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_aa4aabb2b3701119287c42bfde" ON "transcript_segments" ("interaction_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_72d41fd5f5f0ef598cb6b2cfc2" ON "transcript_segments" ("speaker_entity_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_dfb46f38102bf0c472d104cc9e" ON "transcript_segments" ("start_time") `);
        await queryRunner.query(`CREATE TABLE "interaction_summaries" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "interaction_id" uuid NOT NULL, "summary_text" text NOT NULL, "key_points" jsonb, "decisions" jsonb, "action_items" jsonb, "facts_extracted" jsonb, "embedding" vector(1536), "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_df7be1a73cff6b48767585cc2bf" UNIQUE ("interaction_id"), CONSTRAINT "REL_df7be1a73cff6b48767585cc2b" UNIQUE ("interaction_id"), CONSTRAINT "PK_af669117118d5f3aecebe96c64b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "interactions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" character varying(50) NOT NULL, "source" character varying(50) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'active', "started_at" TIMESTAMP WITH TIME ZONE NOT NULL, "ended_at" TIMESTAMP WITH TIME ZONE, "source_metadata" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_911b7416a6671b4148b18c18ecb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_ef9fade8e5a6dac06ef5031986" ON "interactions" ("type") `);
        await queryRunner.query(`CREATE INDEX "IDX_3453a093660295dd9416ede638" ON "interactions" ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_ec737d5f4387db3bdaca8f4270" ON "interactions" ("started_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_1a942af71aa372b8573474dc2c" ON "interactions" ("type", "status") `);
        await queryRunner.query(`CREATE TABLE "entity_facts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "entity_id" uuid NOT NULL, "fact_type" character varying(50) NOT NULL, "category" character varying(50) NOT NULL, "value" character varying(500), "value_date" date, "value_json" jsonb, "source" character varying(20) NOT NULL DEFAULT 'manual', "confidence" numeric(3,2), "source_interaction_id" uuid, "valid_from" date, "valid_until" date, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_64daa796302d144e1d1a93b720f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_196d0808c4d48471f7338ba443" ON "entity_facts" ("entity_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_163b29aaf206f2111d23099c01" ON "entity_facts" ("fact_type") `);
        await queryRunner.query(`CREATE INDEX "IDX_d2c85b9ff5f2553281fd814d56" ON "entity_facts" ("entity_id", "fact_type") `);
        await queryRunner.query(`CREATE TYPE "public"."entities_type_enum" AS ENUM('person', 'organization')`);
        await queryRunner.query(`CREATE TABLE "entities" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" "public"."entities_type_enum" NOT NULL, "name" character varying(255) NOT NULL, "organization_id" uuid, "notes" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_8640855ae82083455cbb806173d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d677bf86aa743c29a517a8a3f0" ON "entities" ("name") `);
        await queryRunner.query(`CREATE INDEX "IDX_026bcb1f2ae0056f96605e69fc" ON "entities" ("organization_id") `);
        await queryRunner.query(`CREATE TABLE "pending_entity_resolutions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "identifier_type" character varying(50) NOT NULL, "identifier_value" character varying(255) NOT NULL, "display_name" character varying(255), "status" character varying(20) NOT NULL DEFAULT 'pending', "resolved_entity_id" uuid, "suggestions" jsonb, "sample_message_ids" jsonb, "first_seen_at" TIMESTAMP WITH TIME ZONE NOT NULL, "resolved_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_9bcad82e275565655fcae8b094b" UNIQUE ("identifier_type", "identifier_value"), CONSTRAINT "PK_b18a4b1d98dee9b908c8bfe20a7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b2fc281debcec2dc30161e88ba" ON "pending_entity_resolutions" ("identifier_type") `);
        await queryRunner.query(`CREATE INDEX "IDX_90618c74a64c28f1d925699a14" ON "pending_entity_resolutions" ("status") `);
        await queryRunner.query(`CREATE TABLE "pending_facts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "entity_id" uuid NOT NULL, "fact_type" character varying(50) NOT NULL, "value" character varying(500), "value_date" date, "confidence" numeric(3,2) NOT NULL, "source_quote" text, "source_interaction_id" uuid, "source_message_id" uuid, "status" character varying(20) NOT NULL DEFAULT 'pending', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "reviewed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_b56cd40daeeaf637f4362c0fed3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_1e6f2e10b6f7c194de7cc25680" ON "pending_facts" ("entity_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_5ae6e194d66fd62156b48c9292" ON "pending_facts" ("status") `);
        await queryRunner.query(`CREATE TABLE "jobs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" character varying(50) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'pending', "payload" jsonb NOT NULL, "result" jsonb, "error" text, "attempts" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "started_at" TIMESTAMP WITH TIME ZONE, "completed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_cf0a6c42b72fcc7f7c237def345" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_b3dc188bb49c6597addebf9a18" ON "jobs" ("type") `);
        await queryRunner.query(`CREATE INDEX "IDX_a0c30e3eb9649fe7fbcd336a63" ON "jobs" ("status") `);
        await queryRunner.query(`ALTER TABLE "entity_identifiers" ADD CONSTRAINT "FK_6657d29b182aab9c071a300a634" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "interaction_participants" ADD CONSTRAINT "FK_d98d9ddb22d736ab1713ed33dd4" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "interaction_participants" ADD CONSTRAINT "FK_f0484dbe65dbcd0b711067772a4" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "messages" ADD CONSTRAINT "FK_99dcff25ef677ca9a24cb4f640b" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "messages" ADD CONSTRAINT "FK_41ffb1bd9c518c832d703156d8a" FOREIGN KEY ("sender_entity_id") REFERENCES "entities"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "messages" ADD CONSTRAINT "FK_7f87cbb925b1267778a7f4c5d67" FOREIGN KEY ("reply_to_message_id") REFERENCES "messages"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "transcript_segments" ADD CONSTRAINT "FK_aa4aabb2b3701119287c42bfde0" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "transcript_segments" ADD CONSTRAINT "FK_72d41fd5f5f0ef598cb6b2cfc28" FOREIGN KEY ("speaker_entity_id") REFERENCES "entities"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "interaction_summaries" ADD CONSTRAINT "FK_df7be1a73cff6b48767585cc2bf" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "entity_facts" ADD CONSTRAINT "FK_196d0808c4d48471f7338ba4431" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "entity_facts" ADD CONSTRAINT "FK_896e75eae0649cdad621865778d" FOREIGN KEY ("source_interaction_id") REFERENCES "interactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "entities" ADD CONSTRAINT "FK_026bcb1f2ae0056f96605e69fc4" FOREIGN KEY ("organization_id") REFERENCES "entities"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pending_entity_resolutions" ADD CONSTRAINT "FK_1641fb14089c3a5cb81da532550" FOREIGN KEY ("resolved_entity_id") REFERENCES "entities"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pending_facts" ADD CONSTRAINT "FK_1e6f2e10b6f7c194de7cc256802" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pending_facts" ADD CONSTRAINT "FK_80998fc920b4787d2b53114f5cc" FOREIGN KEY ("source_interaction_id") REFERENCES "interactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pending_facts" ADD CONSTRAINT "FK_f2e28ac217a2553bd0455d337a6" FOREIGN KEY ("source_message_id") REFERENCES "messages"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "pending_facts" DROP CONSTRAINT "FK_f2e28ac217a2553bd0455d337a6"`);
        await queryRunner.query(`ALTER TABLE "pending_facts" DROP CONSTRAINT "FK_80998fc920b4787d2b53114f5cc"`);
        await queryRunner.query(`ALTER TABLE "pending_facts" DROP CONSTRAINT "FK_1e6f2e10b6f7c194de7cc256802"`);
        await queryRunner.query(`ALTER TABLE "pending_entity_resolutions" DROP CONSTRAINT "FK_1641fb14089c3a5cb81da532550"`);
        await queryRunner.query(`ALTER TABLE "entities" DROP CONSTRAINT "FK_026bcb1f2ae0056f96605e69fc4"`);
        await queryRunner.query(`ALTER TABLE "entity_facts" DROP CONSTRAINT "FK_896e75eae0649cdad621865778d"`);
        await queryRunner.query(`ALTER TABLE "entity_facts" DROP CONSTRAINT "FK_196d0808c4d48471f7338ba4431"`);
        await queryRunner.query(`ALTER TABLE "interaction_summaries" DROP CONSTRAINT "FK_df7be1a73cff6b48767585cc2bf"`);
        await queryRunner.query(`ALTER TABLE "transcript_segments" DROP CONSTRAINT "FK_72d41fd5f5f0ef598cb6b2cfc28"`);
        await queryRunner.query(`ALTER TABLE "transcript_segments" DROP CONSTRAINT "FK_aa4aabb2b3701119287c42bfde0"`);
        await queryRunner.query(`ALTER TABLE "messages" DROP CONSTRAINT "FK_7f87cbb925b1267778a7f4c5d67"`);
        await queryRunner.query(`ALTER TABLE "messages" DROP CONSTRAINT "FK_41ffb1bd9c518c832d703156d8a"`);
        await queryRunner.query(`ALTER TABLE "messages" DROP CONSTRAINT "FK_99dcff25ef677ca9a24cb4f640b"`);
        await queryRunner.query(`ALTER TABLE "interaction_participants" DROP CONSTRAINT "FK_f0484dbe65dbcd0b711067772a4"`);
        await queryRunner.query(`ALTER TABLE "interaction_participants" DROP CONSTRAINT "FK_d98d9ddb22d736ab1713ed33dd4"`);
        await queryRunner.query(`ALTER TABLE "entity_identifiers" DROP CONSTRAINT "FK_6657d29b182aab9c071a300a634"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a0c30e3eb9649fe7fbcd336a63"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b3dc188bb49c6597addebf9a18"`);
        await queryRunner.query(`DROP TABLE "jobs"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5ae6e194d66fd62156b48c9292"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1e6f2e10b6f7c194de7cc25680"`);
        await queryRunner.query(`DROP TABLE "pending_facts"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_90618c74a64c28f1d925699a14"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b2fc281debcec2dc30161e88ba"`);
        await queryRunner.query(`DROP TABLE "pending_entity_resolutions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_026bcb1f2ae0056f96605e69fc"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d677bf86aa743c29a517a8a3f0"`);
        await queryRunner.query(`DROP TABLE "entities"`);
        await queryRunner.query(`DROP TYPE "public"."entities_type_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d2c85b9ff5f2553281fd814d56"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_163b29aaf206f2111d23099c01"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_196d0808c4d48471f7338ba443"`);
        await queryRunner.query(`DROP TABLE "entity_facts"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1a942af71aa372b8573474dc2c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ec737d5f4387db3bdaca8f4270"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3453a093660295dd9416ede638"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ef9fade8e5a6dac06ef5031986"`);
        await queryRunner.query(`DROP TABLE "interactions"`);
        await queryRunner.query(`DROP TABLE "interaction_summaries"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_dfb46f38102bf0c472d104cc9e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_72d41fd5f5f0ef598cb6b2cfc2"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_aa4aabb2b3701119287c42bfde"`);
        await queryRunner.query(`DROP TABLE "transcript_segments"`);
        // Vector index dropped manually if exists
        await queryRunner.query(`DROP INDEX "public"."IDX_f2113da562ea5bb1ddff44ff60"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_41ffb1bd9c518c832d703156d8"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_99dcff25ef677ca9a24cb4f640"`);
        await queryRunner.query(`DROP TABLE "messages"`);
        await queryRunner.query(`DROP TABLE "interaction_participants"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_20ac546eb9c7ec66b8dce6d09f"`);
        await queryRunner.query(`DROP TABLE "entity_identifiers"`);
    }

}
