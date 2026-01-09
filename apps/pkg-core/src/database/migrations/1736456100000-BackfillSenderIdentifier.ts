import { MigrationInterface, QueryRunner } from "typeorm";

export class BackfillSenderIdentifier1736456100000 implements MigrationInterface {
    name = 'BackfillSenderIdentifier1736456100000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Backfill sender_identifier for private chats (user_XXX format)
        // For incoming messages (is_outgoing = false), the sender is the user in the chat_id
        await queryRunner.query(`
            UPDATE messages m
            SET
                sender_identifier_type = 'telegram_user_id',
                sender_identifier_value = SUBSTRING(i.source_metadata->>'telegram_chat_id' FROM 6)
            FROM interactions i
            WHERE m.interaction_id = i.id
              AND m.is_outgoing = false
              AND m.sender_identifier_value IS NULL
              AND i.source_metadata->>'telegram_chat_id' LIKE 'user_%'
        `);

        // For group chats and channels, try to get sender from the only non-self participant
        // This only works if there's exactly one non-self participant in the interaction
        // FIXED: GROUP BY interaction_id only to count participants correctly
        await queryRunner.query(`
            WITH single_participant_interactions AS (
                SELECT ip.interaction_id
                FROM interaction_participants ip
                WHERE ip.role = 'participant'
                GROUP BY ip.interaction_id
                HAVING COUNT(*) = 1
            ),
            participant_details AS (
                SELECT ip.interaction_id, ip.identifier_type, ip.identifier_value
                FROM interaction_participants ip
                JOIN single_participant_interactions spi ON ip.interaction_id = spi.interaction_id
                WHERE ip.role = 'participant'
            )
            UPDATE messages m
            SET
                sender_identifier_type = pd.identifier_type,
                sender_identifier_value = pd.identifier_value
            FROM participant_details pd
            WHERE m.interaction_id = pd.interaction_id
              AND m.is_outgoing = false
              AND m.sender_identifier_value IS NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Clear backfilled data (though this is generally not reversible in a meaningful way)
        await queryRunner.query(`
            UPDATE messages
            SET sender_identifier_type = NULL, sender_identifier_value = NULL
            WHERE sender_identifier_type IS NOT NULL
        `);
    }
}
