import { MigrationInterface, QueryRunner } from "typeorm";

export class AddActivityCommitmentEntities1769726497007 implements MigrationInterface {
    name = 'AddActivityCommitmentEntities1769726497007'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Create activities table with closure-table hierarchy
        await queryRunner.query(`CREATE TABLE "activities" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(500) NOT NULL, "activity_type" character varying(30) NOT NULL, "description" text, "status" character varying(20) NOT NULL DEFAULT 'active', "priority" character varying(20) NOT NULL DEFAULT 'medium', "context" character varying(20) NOT NULL DEFAULT 'any', "parent_id" uuid, "depth" integer NOT NULL DEFAULT '0', "materialized_path" text, "owner_entity_id" uuid NOT NULL, "client_entity_id" uuid, "deadline" TIMESTAMP WITH TIME ZONE, "start_date" TIMESTAMP WITH TIME ZONE, "end_date" TIMESTAMP WITH TIME ZONE, "recurrence_rule" character varying(100), "metadata" jsonb, "tags" text array, "progress" integer, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "last_activity_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_7f4004429f731ffb9c88eb486a8" PRIMARY KEY ("id"))`);

        // Add comments for activities columns
        await queryRunner.query(`COMMENT ON COLUMN "activities"."name" IS 'Название активности'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."activity_type" IS 'Тип активности (area, business, project, task, etc.)'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."description" IS 'Подробное описание активности'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."status" IS 'Статус: idea, active, paused, completed, cancelled, archived'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."priority" IS 'Приоритет: critical, high, medium, low, none'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."context" IS 'Контекст для напоминаний: work, personal, any, location_based'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."parent_id" IS 'ID родительской активности (closure-table hierarchy)'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."depth" IS 'Глубина в дереве (0 = корень)'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."materialized_path" IS 'Materialized path: uuid1/uuid2/uuid3 от корня к текущему'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."owner_entity_id" IS 'ID владельца активности (обычно isOwner=true entity)'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."client_entity_id" IS 'ID клиента/заказчика (для клиентских проектов)'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."deadline" IS 'Дедлайн выполнения'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."start_date" IS 'Дата начала работы над активностью'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."end_date" IS 'Фактическая дата завершения'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."recurrence_rule" IS 'Cron-выражение для повторяющихся активностей'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."metadata" IS 'Расширяемые метаданные: tags, color, external_ids, etc.'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."tags" IS 'Теги для быстрой фильтрации (GIN index)'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."progress" IS 'Прогресс выполнения 0-100%'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."created_at" IS 'Дата создания записи'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."updated_at" IS 'Дата последнего обновления'`);
        await queryRunner.query(`COMMENT ON COLUMN "activities"."last_activity_at" IS 'Timestamp последней активности (сообщение, коммит, etc.)'`);

        // Create indexes for activities
        await queryRunner.query(`CREATE INDEX "IDX_activities_name" ON "activities" ("name")`);
        await queryRunner.query(`CREATE INDEX "IDX_activities_materialized_path" ON "activities" ("materialized_path")`);
        await queryRunner.query(`CREATE INDEX "IDX_activities_last_activity_at" ON "activities" ("last_activity_at")`);
        await queryRunner.query(`CREATE INDEX "idx_activities_deadline" ON "activities" ("deadline")`);
        await queryRunner.query(`CREATE INDEX "idx_activities_status" ON "activities" ("status")`);
        await queryRunner.query(`CREATE INDEX "idx_activities_type" ON "activities" ("activity_type")`);
        await queryRunner.query(`CREATE INDEX "idx_activities_client" ON "activities" ("client_entity_id")`);
        await queryRunner.query(`CREATE INDEX "idx_activities_owner" ON "activities" ("owner_entity_id")`);

        // Create activity_members table
        await queryRunner.query(`CREATE TABLE "activity_members" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "activity_id" uuid NOT NULL, "entity_id" uuid NOT NULL, "role" character varying(20) NOT NULL DEFAULT 'member', "notes" text, "is_active" boolean NOT NULL DEFAULT true, "joined_at" TIMESTAMP WITH TIME ZONE, "left_at" TIMESTAMP WITH TIME ZONE, "metadata" jsonb, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "uq_activity_member" UNIQUE ("activity_id", "entity_id", "role"), CONSTRAINT "PK_ad3d1819e45639295ca5810e30d" PRIMARY KEY ("id"))`);

        // Add comments for activity_members columns
        await queryRunner.query(`COMMENT ON COLUMN "activity_members"."activity_id" IS 'ID связанной активности'`);
        await queryRunner.query(`COMMENT ON COLUMN "activity_members"."entity_id" IS 'ID участника (Entity: person или organization)'`);
        await queryRunner.query(`COMMENT ON COLUMN "activity_members"."role" IS 'Роль: owner, member, observer, assignee, reviewer, client, consultant'`);
        await queryRunner.query(`COMMENT ON COLUMN "activity_members"."notes" IS 'Заметки о роли/обязанностях участника'`);
        await queryRunner.query(`COMMENT ON COLUMN "activity_members"."is_active" IS 'Активен ли участник (false = временно исключён)'`);
        await queryRunner.query(`COMMENT ON COLUMN "activity_members"."joined_at" IS 'Дата присоединения к активности'`);
        await queryRunner.query(`COMMENT ON COLUMN "activity_members"."left_at" IS 'Дата выхода из активности'`);
        await queryRunner.query(`COMMENT ON COLUMN "activity_members"."metadata" IS 'Дополнительные метаданные: permissions, preferences, etc.'`);
        await queryRunner.query(`COMMENT ON COLUMN "activity_members"."created_at" IS 'Дата создания записи'`);
        await queryRunner.query(`COMMENT ON COLUMN "activity_members"."updated_at" IS 'Дата последнего обновления'`);

        // Create indexes for activity_members
        await queryRunner.query(`CREATE INDEX "idx_activity_members_entity" ON "activity_members" ("entity_id")`);
        await queryRunner.query(`CREATE INDEX "idx_activity_members_activity" ON "activity_members" ("activity_id")`);

        // Create commitments table
        await queryRunner.query(`CREATE TABLE "commitments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" character varying(20) NOT NULL, "title" character varying(500) NOT NULL, "description" text, "status" character varying(20) NOT NULL DEFAULT 'pending', "priority" character varying(20) NOT NULL DEFAULT 'medium', "from_entity_id" uuid NOT NULL, "to_entity_id" uuid NOT NULL, "activity_id" uuid, "source_message_id" uuid, "extracted_event_id" uuid, "due_date" TIMESTAMP WITH TIME ZONE, "completed_at" TIMESTAMP WITH TIME ZONE, "recurrence_rule" character varying(100), "next_reminder_at" TIMESTAMP WITH TIME ZONE, "reminder_count" integer NOT NULL DEFAULT '0', "confidence" double precision, "metadata" jsonb, "notes" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_82060edcfe810ce82b7565521af" PRIMARY KEY ("id"))`);

        // Add comments for commitments columns
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."type" IS 'Тип: promise, request, agreement, deadline, reminder, recurring'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."title" IS 'Краткое описание обязательства'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."description" IS 'Подробное описание обязательства'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."status" IS 'Статус: pending, in_progress, completed, cancelled, overdue, deferred'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."priority" IS 'Приоритет: critical, high, medium, low'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."from_entity_id" IS 'ID того, кто дал обещание (источник)'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."to_entity_id" IS 'ID того, кому дано обещание (получатель)'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."activity_id" IS 'ID связанной активности (проект/задача)'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."source_message_id" IS 'ID сообщения, из которого извлечено обязательство'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."extracted_event_id" IS 'ID ExtractedEvent, из которого создано (связь с extraction pipeline)'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."due_date" IS 'Срок выполнения обязательства'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."completed_at" IS 'Дата фактического выполнения'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."recurrence_rule" IS 'Cron-выражение для периодических обязательств'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."next_reminder_at" IS 'Дата/время следующего напоминания'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."reminder_count" IS 'Количество отправленных напоминаний'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."confidence" IS 'Уверенность извлечения 0-1 (для автоматически извлечённых)'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."metadata" IS 'Дополнительные метаданные: context, extracted_phrases, etc.'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."notes" IS 'Ручные заметки пользователя'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."created_at" IS 'Дата создания записи'`);
        await queryRunner.query(`COMMENT ON COLUMN "commitments"."updated_at" IS 'Дата последнего обновления'`);

        // Create indexes for commitments
        await queryRunner.query(`CREATE INDEX "IDX_commitments_title" ON "commitments" ("title")`);
        await queryRunner.query(`CREATE INDEX "IDX_commitments_next_reminder_at" ON "commitments" ("next_reminder_at")`);
        await queryRunner.query(`CREATE INDEX "idx_commitments_activity" ON "commitments" ("activity_id")`);
        await queryRunner.query(`CREATE INDEX "idx_commitments_due" ON "commitments" ("due_date")`);
        await queryRunner.query(`CREATE INDEX "idx_commitments_status" ON "commitments" ("status")`);
        await queryRunner.query(`CREATE INDEX "idx_commitments_to" ON "commitments" ("to_entity_id")`);
        await queryRunner.query(`CREATE INDEX "idx_commitments_from" ON "commitments" ("from_entity_id")`);

        // Create activities_closure table for TypeORM Tree structure
        await queryRunner.query(`CREATE TABLE "activities_closure" ("id_ancestor" uuid NOT NULL, "id_descendant" uuid NOT NULL, CONSTRAINT "PK_activities_closure" PRIMARY KEY ("id_ancestor", "id_descendant"))`);
        await queryRunner.query(`CREATE INDEX "IDX_activities_closure_ancestor" ON "activities_closure" ("id_ancestor")`);
        await queryRunner.query(`CREATE INDEX "IDX_activities_closure_descendant" ON "activities_closure" ("id_descendant")`);

        // Add foreign keys for activities
        await queryRunner.query(`ALTER TABLE "activities" ADD CONSTRAINT "FK_activities_parent" FOREIGN KEY ("parent_id") REFERENCES "activities"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "activities" ADD CONSTRAINT "FK_activities_owner_entity" FOREIGN KEY ("owner_entity_id") REFERENCES "entities"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "activities" ADD CONSTRAINT "FK_activities_client_entity" FOREIGN KEY ("client_entity_id") REFERENCES "entities"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);

        // Add foreign keys for activity_members
        await queryRunner.query(`ALTER TABLE "activity_members" ADD CONSTRAINT "FK_activity_members_activity" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "activity_members" ADD CONSTRAINT "FK_activity_members_entity" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        // Add foreign keys for commitments
        await queryRunner.query(`ALTER TABLE "commitments" ADD CONSTRAINT "FK_commitments_from_entity" FOREIGN KEY ("from_entity_id") REFERENCES "entities"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "commitments" ADD CONSTRAINT "FK_commitments_to_entity" FOREIGN KEY ("to_entity_id") REFERENCES "entities"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "commitments" ADD CONSTRAINT "FK_commitments_activity" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "commitments" ADD CONSTRAINT "FK_commitments_source_message" FOREIGN KEY ("source_message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "commitments" ADD CONSTRAINT "FK_commitments_extracted_event" FOREIGN KEY ("extracted_event_id") REFERENCES "extracted_events"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);

        // Add foreign keys for activities_closure
        await queryRunner.query(`ALTER TABLE "activities_closure" ADD CONSTRAINT "FK_activities_closure_ancestor" FOREIGN KEY ("id_ancestor") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "activities_closure" ADD CONSTRAINT "FK_activities_closure_descendant" FOREIGN KEY ("id_descendant") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drop foreign keys for activities_closure
        await queryRunner.query(`ALTER TABLE "activities_closure" DROP CONSTRAINT "FK_activities_closure_descendant"`);
        await queryRunner.query(`ALTER TABLE "activities_closure" DROP CONSTRAINT "FK_activities_closure_ancestor"`);

        // Drop foreign keys for commitments
        await queryRunner.query(`ALTER TABLE "commitments" DROP CONSTRAINT "FK_commitments_extracted_event"`);
        await queryRunner.query(`ALTER TABLE "commitments" DROP CONSTRAINT "FK_commitments_source_message"`);
        await queryRunner.query(`ALTER TABLE "commitments" DROP CONSTRAINT "FK_commitments_activity"`);
        await queryRunner.query(`ALTER TABLE "commitments" DROP CONSTRAINT "FK_commitments_to_entity"`);
        await queryRunner.query(`ALTER TABLE "commitments" DROP CONSTRAINT "FK_commitments_from_entity"`);

        // Drop foreign keys for activity_members
        await queryRunner.query(`ALTER TABLE "activity_members" DROP CONSTRAINT "FK_activity_members_entity"`);
        await queryRunner.query(`ALTER TABLE "activity_members" DROP CONSTRAINT "FK_activity_members_activity"`);

        // Drop foreign keys for activities
        await queryRunner.query(`ALTER TABLE "activities" DROP CONSTRAINT "FK_activities_client_entity"`);
        await queryRunner.query(`ALTER TABLE "activities" DROP CONSTRAINT "FK_activities_owner_entity"`);
        await queryRunner.query(`ALTER TABLE "activities" DROP CONSTRAINT "FK_activities_parent"`);

        // Drop activities_closure table
        await queryRunner.query(`DROP INDEX "public"."IDX_activities_closure_descendant"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_activities_closure_ancestor"`);
        await queryRunner.query(`DROP TABLE "activities_closure"`);

        // Drop commitments table and indexes
        await queryRunner.query(`DROP INDEX "public"."idx_commitments_from"`);
        await queryRunner.query(`DROP INDEX "public"."idx_commitments_to"`);
        await queryRunner.query(`DROP INDEX "public"."idx_commitments_status"`);
        await queryRunner.query(`DROP INDEX "public"."idx_commitments_due"`);
        await queryRunner.query(`DROP INDEX "public"."idx_commitments_activity"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_commitments_next_reminder_at"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_commitments_title"`);
        await queryRunner.query(`DROP TABLE "commitments"`);

        // Drop activity_members table and indexes
        await queryRunner.query(`DROP INDEX "public"."idx_activity_members_activity"`);
        await queryRunner.query(`DROP INDEX "public"."idx_activity_members_entity"`);
        await queryRunner.query(`DROP TABLE "activity_members"`);

        // Drop activities table and indexes
        await queryRunner.query(`DROP INDEX "public"."idx_activities_owner"`);
        await queryRunner.query(`DROP INDEX "public"."idx_activities_client"`);
        await queryRunner.query(`DROP INDEX "public"."idx_activities_type"`);
        await queryRunner.query(`DROP INDEX "public"."idx_activities_status"`);
        await queryRunner.query(`DROP INDEX "public"."idx_activities_deadline"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_activities_last_activity_at"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_activities_materialized_path"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_activities_name"`);
        await queryRunner.query(`DROP TABLE "activities"`);
    }

}
