import { EntityManager } from 'typeorm';
import {
  PendingApprovalItemType,
  EntityFact,
  EntityFactStatus,
  Activity,
  ActivityStatus,
  Commitment,
  CommitmentStatus,
} from '@pkg/entities';

/**
 * Configuration for each PendingApprovalItemType.
 * Centralizes mapping between item types and their target entities.
 */
interface ItemTypeConfig {
  /** TypeORM Entity class */
  entityClass: typeof EntityFact | typeof Activity | typeof Commitment;
  /** PostgreSQL table name (for raw queries) */
  tableName: string;
  /** Status value to set when activating (approving) */
  activeStatus: string;
  /** Status value indicating a draft entity */
  draftStatus: string;
}

/**
 * Registry mapping PendingApprovalItemType to entity configurations.
 *
 * Single source of truth for:
 * - Entity class mapping (activateTarget, softDelete, hardDelete)
 * - Table name mapping (bulk operations)
 * - Status value mapping (activation)
 *
 * Adding a new item type:
 * 1. Add new entry to ITEM_TYPE_REGISTRY
 * 2. That's it - all services will pick it up automatically
 */
export const ITEM_TYPE_REGISTRY: Record<PendingApprovalItemType, ItemTypeConfig> = {
  [PendingApprovalItemType.FACT]: {
    entityClass: EntityFact,
    tableName: 'entity_facts',
    activeStatus: EntityFactStatus.ACTIVE,
    draftStatus: EntityFactStatus.DRAFT,
  },
  [PendingApprovalItemType.PROJECT]: {
    entityClass: Activity,
    tableName: 'activities',
    activeStatus: ActivityStatus.ACTIVE,
    draftStatus: ActivityStatus.DRAFT,
  },
  [PendingApprovalItemType.TASK]: {
    entityClass: Activity,
    tableName: 'activities',
    activeStatus: ActivityStatus.ACTIVE,
    draftStatus: ActivityStatus.DRAFT,
  },
  [PendingApprovalItemType.COMMITMENT]: {
    entityClass: Commitment,
    tableName: 'commitments',
    // Commitment: draft → pending (natural initial state for commitments)
    activeStatus: CommitmentStatus.PENDING,
    draftStatus: CommitmentStatus.DRAFT,
  },
};

/**
 * Get configuration for an item type.
 * Returns null if item type is not registered (for graceful handling of dynamic values).
 */
export function getItemTypeConfigSafe(itemType: PendingApprovalItemType): ItemTypeConfig | null {
  return ITEM_TYPE_REGISTRY[itemType] ?? null;
}

/**
 * Get configuration for an item type.
 * Throws if item type is not registered (compile-time exhaustiveness check).
 */
export function getItemTypeConfig(itemType: PendingApprovalItemType): ItemTypeConfig {
  const config = getItemTypeConfigSafe(itemType);
  if (!config) {
    // This should never happen due to TypeScript's exhaustiveness check
    // But serves as runtime safety for dynamic values
    throw new Error(`Unknown item type: ${itemType}`);
  }
  return config;
}

/**
 * Activate target entity (set status to active).
 * Returns true if entity was found and updated.
 */
export async function activateTarget(
  manager: EntityManager,
  itemType: PendingApprovalItemType,
  targetId: string,
): Promise<boolean> {
  const config = getItemTypeConfig(itemType);
  // Use type assertion because TypeScript can't narrow union types through config lookup
  // The registry guarantees type safety: entityClass and activeStatus are always compatible
  const result = await manager.update(
    config.entityClass as typeof EntityFact,
    { id: targetId },
    { status: config.activeStatus as EntityFactStatus },
  );
  return (result.affected ?? 0) > 0;
}

/**
 * Soft delete target entity (set deletedAt = now()).
 */
export async function softDeleteTarget(
  manager: EntityManager,
  itemType: PendingApprovalItemType,
  targetId: string,
): Promise<void> {
  const config = getItemTypeConfig(itemType);
  await manager.softDelete(config.entityClass, { id: targetId });
}

/**
 * Hard delete target entity.
 */
export async function hardDeleteTarget(
  manager: EntityManager,
  itemType: PendingApprovalItemType,
  targetId: string,
): Promise<void> {
  const config = getItemTypeConfig(itemType);
  await manager.delete(config.entityClass, { id: targetId });
}

/**
 * Update target entity fields.
 * Only updates fields that are provided (partial update).
 * Returns true if entity was found and updated.
 */
export async function updateTarget(
  manager: EntityManager,
  itemType: PendingApprovalItemType,
  targetId: string,
  updates: Record<string, unknown>,
): Promise<boolean> {
  if (Object.keys(updates).length === 0) {
    return true; // Nothing to update
  }

  const config = getItemTypeConfig(itemType);
  const result = await manager.update(
    config.entityClass as typeof EntityFact,
    { id: targetId },
    updates,
  );
  return (result.affected ?? 0) > 0;
}

/**
 * Hard delete multiple target entities.
 * Uses raw SQL for efficiency.
 * Returns number of deleted rows (0 for unknown item types).
 */
export async function hardDeleteTargets(
  manager: EntityManager,
  itemType: PendingApprovalItemType,
  targetIds: string[],
): Promise<number> {
  if (targetIds.length === 0) return 0;

  const config = getItemTypeConfigSafe(itemType);
  if (!config) {
    // Graceful handling of unknown types - log and return 0
    // This can happen with legacy data or testing
    return 0;
  }

  const result = await manager.query(
    `DELETE FROM ${config.tableName} WHERE id = ANY($1::uuid[])`,
    [targetIds],
  );

  // PostgreSQL pg driver: result has rowCount property
  const rowCount =
    (result as unknown as { rowCount?: number })?.rowCount ??
    (Array.isArray(result) ? (result as unknown as { rowCount?: number }).rowCount : undefined) ??
    0;

  return rowCount;
}

/**
 * Get all item types that map to a given table name.
 * Useful for cleanup service to find orphaned entities.
 */
export function getItemTypesForTable(tableName: string): PendingApprovalItemType[] {
  return Object.entries(ITEM_TYPE_REGISTRY)
    .filter(([, config]) => config.tableName === tableName)
    .map(([itemType]) => itemType as PendingApprovalItemType);
}

/**
 * Get unique table configurations grouped by table name.
 * Avoids duplicate processing for PROJECT/TASK which share the same table.
 */
export function getUniqueTableConfigs(): Array<{
  tableName: string;
  draftStatus: string;
  itemTypes: PendingApprovalItemType[];
}> {
  const tableMap = new Map<string, { draftStatus: string; itemTypes: PendingApprovalItemType[] }>();

  for (const [itemType, config] of Object.entries(ITEM_TYPE_REGISTRY)) {
    const existing = tableMap.get(config.tableName);
    if (existing) {
      existing.itemTypes.push(itemType as PendingApprovalItemType);
    } else {
      tableMap.set(config.tableName, {
        draftStatus: config.draftStatus,
        itemTypes: [itemType as PendingApprovalItemType],
      });
    }
  }

  return Array.from(tableMap.entries()).map(([tableName, data]) => ({
    tableName,
    ...data,
  }));
}
