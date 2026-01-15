import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User, UserRole, UserStatus } from '@pkg/entities';
import { v4 as uuidv4 } from 'uuid';

/**
 * Seed script to create initial admin user
 *
 * Usage: Run with ts-node or after building
 *   npx ts-node -r tsconfig-paths/register src/database/seeds/admin-user.seed.ts
 *
 * Or import and call from a CLI command
 */
export async function seedAdminUser(dataSource: DataSource): Promise<void> {
  const userRepository = dataSource.getRepository(User);

  // Check if admin already exists
  const existingAdmin = await userRepository.findOne({
    where: { username: 'admin' },
  });

  if (existingAdmin) {
    console.log('Admin user already exists, skipping seed');
    return;
  }

  // Get password from environment or generate random
  const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || generateRandomPassword();

  // Hash password
  const passwordHash = await bcrypt.hash(initialPassword, 12);

  // Create admin user
  const admin = userRepository.create({
    id: uuidv4(),
    username: 'admin',
    email: process.env.ADMIN_EMAIL || null,
    passwordHash,
    displayName: 'Administrator',
    role: UserRole.ADMIN,
    status: UserStatus.ACTIVE,
    metadata: {
      createdBy: 'seed',
      seedVersion: '1.0.0',
    },
  });

  await userRepository.save(admin);

  console.log('='.repeat(60));
  console.log('Admin user created successfully!');
  console.log('='.repeat(60));
  console.log('Username: admin');

  if (!process.env.ADMIN_INITIAL_PASSWORD) {
    console.log(`Password: ${initialPassword}`);
    console.log('');
    console.log('⚠️  IMPORTANT: Please change this password immediately!');
  } else {
    console.log('Password: (from ADMIN_INITIAL_PASSWORD environment variable)');
  }
  console.log('='.repeat(60));
}

function generateRandomPassword(): string {
  const length = 16;
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return password;
}

// Run directly if executed as script
if (require.main === module) {
  (async () => {
    // Import data source
    const AppDataSource = (await import('../data-source')).default;

    try {
      await AppDataSource.initialize();
      await seedAdminUser(AppDataSource);
      await AppDataSource.destroy();
      process.exit(0);
    } catch (error) {
      console.error('Error seeding admin user:', error);
      process.exit(1);
    }
  })();
}
