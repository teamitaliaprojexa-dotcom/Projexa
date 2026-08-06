import db from '../config/database.js';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

async function seed() {
  try {
    console.log('🌱 Starting database seed...\n');

    // 1. Create tenants
    console.log('Creating tenants...');
    const tenant1Id = uuidv4();
    const tenant2Id = uuidv4();

    await db.query(
      'INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3), ($4, $5, $6)',
      [
        tenant1Id, 'Projexa Internal', 'projexa-internal',
        tenant2Id, 'Test Company', 'test-company'
      ]
    );
    console.log('✓ Tenants created\n');

    // 2. Create admin user
    console.log('Creating users...');
    const adminId = uuidv4();
    const passwordHash = await bcrypt.hash('temp123', 10);

    await db.query(
      'INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
      [
        adminId, 'admin@projexa.com', 'Admin User', passwordHash,
        uuidv4(), 'user@projexa.com', 'Regular User', passwordHash
      ]
    );
    console.log('✓ Users created\n');

    // 3. Create user-tenant relationships
    console.log('Creating user-tenant relationships...');
    const userId = (await db.query('SELECT id FROM users WHERE email = $1', ['user@projexa.com'])).rows[0].id;

    await db.query(
      'INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)',
      [
        adminId, tenant1Id, 'admin',
        adminId, tenant2Id, 'admin',
        userId, tenant1Id, 'member'
      ]
    );
    console.log('✓ User-tenant relationships created\n');

    // 4. Create sample projects
    console.log('Creating sample projects...');
    const project1Id = uuidv4();
    const project2Id = uuidv4();

    await db.query(
      'INSERT INTO projects (id, tenant_id, name, description, status, created_by) VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)',
      [
        project1Id, tenant1Id, 'Website Redesign', 'Redesign the company website', 'active', adminId,
        project2Id, tenant1Id, 'Mobile App', 'Build a mobile app for iOS and Android', 'planning', adminId
      ]
    );
    console.log('✓ Projects created\n');

    // 5. Create sample tasks
    console.log('Creating sample tasks...');
    await db.query(
      'INSERT INTO tasks (id, project_id, title, description, status, priority, assigned_to, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8), ($9, $10, $11, $12, $13, $14, $15, $16)',
      [
        uuidv4(), project1Id, 'Design Homepage', 'Create homepage mockups', 'in_progress', 'high', userId, adminId,
        uuidv4(), project1Id, 'Setup Analytics', 'Integrate Google Analytics', 'todo', 'medium', adminId, adminId
      ]
    );
    console.log('✓ Tasks created\n');

    // 6. Create sample risks
    console.log('Creating sample risks...');
    await db.query(
      'INSERT INTO risks (id, project_id, title, description, probability, impact, status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        uuidv4(), project1Id, 'Scope Creep', 'Project scope might increase', 'high', 'high', 'open', adminId
      ]
    );
    console.log('✓ Risks created\n');

    console.log('✅ Database seed completed successfully!\n');
    console.log('Test Credentials:');
    console.log('  Email: admin@projexa.com');
    console.log('  Password: temp123');
    console.log('  Tenants: Projexa Internal, Test Company\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Seed error:', error);
    process.exit(1);
  }
}

seed();
