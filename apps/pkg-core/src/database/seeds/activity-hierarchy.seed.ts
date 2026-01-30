import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import {
  Activity,
  ActivityType,
  ActivityStatus,
  ActivityContext,
  ActivityPriority,
  EntityRecord,
} from '@pkg/entities';

/**
 * Seed script to create initial activity hierarchy
 *
 * Creates the base structure:
 * - Areas: Работа, Семья
 * - Businesses (under Работа): ИИ-Сервисы, ГуглШитс.ру
 * - Directions (under ГуглШитс.ру): Канал, Сайт, Клиентская работа
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/database/seeds/activity-hierarchy.seed.ts
 */
export async function seedActivityHierarchy(dataSource: DataSource): Promise<void> {
  const activityRepo = dataSource.getRepository(Activity);
  const entityRepo = dataSource.getRepository(EntityRecord);

  // Find owner entity
  const ownerEntity = await entityRepo.findOne({
    where: { isOwner: true },
  });

  if (!ownerEntity) {
    console.log('⚠️  No owner entity found. Please create an owner entity first.');
    console.log('   Run the entity seed or create manually with isOwner = true');
    return;
  }

  console.log(`Found owner entity: ${ownerEntity.name} (${ownerEntity.id})`);

  // Check if activities already exist
  const existingCount = await activityRepo.count();
  if (existingCount > 0) {
    console.log(`Activities already exist (${existingCount} found), skipping seed`);
    return;
  }

  // ===========================================
  // Create Areas (top level)
  // ===========================================

  const areaWork = activityRepo.create({
    id: uuidv4(),
    name: 'Работа',
    activityType: ActivityType.AREA,
    status: ActivityStatus.ACTIVE,
    context: ActivityContext.WORK,
    ownerEntityId: ownerEntity.id,
    priority: ActivityPriority.NONE,
    depth: 0,
    materializedPath: null,
  });

  const areaFamily = activityRepo.create({
    id: uuidv4(),
    name: 'Семья',
    activityType: ActivityType.AREA,
    status: ActivityStatus.ACTIVE,
    context: ActivityContext.PERSONAL,
    ownerEntityId: ownerEntity.id,
    priority: ActivityPriority.NONE,
    depth: 0,
    materializedPath: null,
  });

  await activityRepo.save([areaWork, areaFamily]);
  console.log('✅ Created areas: Работа, Семья');

  // ===========================================
  // Create Businesses (under Работа)
  // ===========================================

  const businessAiServices = activityRepo.create({
    id: uuidv4(),
    name: 'ИИ-Сервисы',
    activityType: ActivityType.BUSINESS,
    status: ActivityStatus.ACTIVE,
    context: ActivityContext.WORK,
    ownerEntityId: ownerEntity.id,
    priority: ActivityPriority.NONE,
    parentId: areaWork.id,
    depth: 1,
    materializedPath: areaWork.id,
  });

  const businessGoogleSheets = activityRepo.create({
    id: uuidv4(),
    name: 'ГуглШитс.ру',
    activityType: ActivityType.BUSINESS,
    status: ActivityStatus.ACTIVE,
    context: ActivityContext.WORK,
    ownerEntityId: ownerEntity.id,
    priority: ActivityPriority.NONE,
    parentId: areaWork.id,
    depth: 1,
    materializedPath: areaWork.id,
  });

  await activityRepo.save([businessAiServices, businessGoogleSheets]);
  console.log('✅ Created businesses: ИИ-Сервисы, ГуглШитс.ру');

  // ===========================================
  // Create Directions (under ГуглШитс.ру)
  // ===========================================

  const dirChannel = activityRepo.create({
    id: uuidv4(),
    name: 'Канал',
    description: 'YouTube канал и контент-маркетинг',
    activityType: ActivityType.DIRECTION,
    status: ActivityStatus.ACTIVE,
    context: ActivityContext.WORK,
    ownerEntityId: ownerEntity.id,
    priority: ActivityPriority.NONE,
    parentId: businessGoogleSheets.id,
    depth: 2,
    materializedPath: `${areaWork.id}/${businessGoogleSheets.id}`,
  });

  const dirSite = activityRepo.create({
    id: uuidv4(),
    name: 'Сайт',
    description: 'Разработка и поддержка сайта',
    activityType: ActivityType.DIRECTION,
    status: ActivityStatus.ACTIVE,
    context: ActivityContext.WORK,
    ownerEntityId: ownerEntity.id,
    priority: ActivityPriority.NONE,
    parentId: businessGoogleSheets.id,
    depth: 2,
    materializedPath: `${areaWork.id}/${businessGoogleSheets.id}`,
  });

  const dirClients = activityRepo.create({
    id: uuidv4(),
    name: 'Клиентская работа',
    description: 'Проекты для клиентов',
    activityType: ActivityType.DIRECTION,
    status: ActivityStatus.ACTIVE,
    context: ActivityContext.WORK,
    ownerEntityId: ownerEntity.id,
    priority: ActivityPriority.NONE,
    parentId: businessGoogleSheets.id,
    depth: 2,
    materializedPath: `${areaWork.id}/${businessGoogleSheets.id}`,
  });

  await activityRepo.save([dirChannel, dirSite, dirClients]);
  console.log('✅ Created directions: Канал, Сайт, Клиентская работа');

  // ===========================================
  // Summary
  // ===========================================

  console.log('');
  console.log('='.repeat(60));
  console.log('Activity hierarchy seeded successfully!');
  console.log('='.repeat(60));
  console.log('');
  console.log('Hierarchy:');
  console.log('├── Работа (area)');
  console.log('│   ├── ИИ-Сервисы (business)');
  console.log('│   └── ГуглШитс.ру (business)');
  console.log('│       ├── Канал (direction)');
  console.log('│       ├── Сайт (direction)');
  console.log('│       └── Клиентская работа (direction)');
  console.log('└── Семья (area)');
  console.log('');
  console.log(`Owner: ${ownerEntity.name}`);
  console.log('='.repeat(60));
}

// Run directly if executed as script
if (require.main === module) {
  (async () => {
    // Import data source
    const AppDataSource = (await import('../data-source')).default;

    try {
      await AppDataSource.initialize();
      await seedActivityHierarchy(AppDataSource);
      await AppDataSource.destroy();
      process.exit(0);
    } catch (error) {
      console.error('Error seeding activity hierarchy:', error);
      process.exit(1);
    }
  })();
}
