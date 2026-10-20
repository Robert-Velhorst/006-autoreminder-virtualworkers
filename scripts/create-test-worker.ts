import dotenv from 'dotenv';
dotenv.config();

import { getDb } from '../server/db.js';
import { users, vaProfiles } from '../drizzle/schema.js';
import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

async function main() {
  const confirmationFlag = '--confirm-create-test-worker';
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to create known-password test accounts in production.');
  }
  if (!process.argv.includes(confirmationFlag)) {
    throw new Error(`Refusing to create test accounts. Re-run with ${confirmationFlag} in a non-production database.`);
  }

  const db = await getDb();
  if (!db) {
    console.error('Failed to connect to database');
    process.exit(1);
  }

  console.log('Database connected successfully.');

  const passwordHash = await bcrypt.hash('password123', 10);

  // 1. Ensure Founder account (founder_test)
  const founderUsername = 'founder_test';
  let [founderUser] = await db.select().from(users).where(eq(users.openId, founderUsername)).limit(1);
  if (!founderUser) {
    console.log(`Creating founder account: ${founderUsername}`);
    await db.insert(users).values({
      openId: founderUsername,
      name: 'Test Founder',
      role: 'admin', // Make admin/founder
      passwordHash,
      loginMethod: 'local',
      lastSignedIn: new Date()
    });
    [founderUser] = await db.select().from(users).where(eq(users.openId, founderUsername)).limit(1);
  } else {
    console.log(`Founder account already exists: ${founderUsername}`);
  }

  // 2. Ensure Worker account (worker_test)
  const workerUsername = 'worker_test';
  let [workerUser] = await db.select().from(users).where(eq(users.openId, workerUsername)).limit(1);
  if (!workerUser) {
    console.log(`Creating worker account: ${workerUsername}`);
    await db.insert(users).values({
      openId: workerUsername,
      name: 'Test Worker',
      role: 'worker',
      passwordHash,
      loginMethod: 'local',
      lastSignedIn: new Date()
    });
    [workerUser] = await db.select().from(users).where(eq(users.openId, workerUsername)).limit(1);
  } else {
    console.log(`Worker account already exists: ${workerUsername}`);
  }

  // 3. Ensure VA Profile
  const profileName = 'Test Virtual Worker';
  let [profile] = await db.select().from(vaProfiles).where(
    and(eq(vaProfiles.name, profileName), eq(vaProfiles.founderId, founderUser.id))
  ).limit(1);

  if (!profile) {
    console.log(`Creating VA profile: ${profileName}`);
    await db.insert(vaProfiles).values({
      founderId: founderUser.id,
      userId: workerUser.id, // Linked to the worker_test account!
      name: profileName,
      email: 'worker_test@example.com',
      timezone: 'Asia/Manila',
      skills: JSON.stringify(['Trello Management', 'Task Execution']),
      workStartHour: 9,
      workEndHour: 18,
      workingDays: '1,2,3,4,5',
      lunchTime: 12,
      lunchDuration: 60,
      status: 'active'
    });
    console.log(`VA profile linked to user: ${workerUsername}`);
  } else {
    console.log(`VA profile already exists: ${profileName}`);
    // Make sure it is linked correctly
    await db.update(vaProfiles).set({
      userId: workerUser.id
    }).where(eq(vaProfiles.id, profile.id));
    console.log(`VA profile updated/linked to user: ${workerUsername}`);
  }

  console.log('\n==================================================');
  console.log('SUCCESS: TEST WORKER AND FOUNDER ACCOUNTS CREATED!');
  console.log('==================================================');
  console.log('You can now log in and test the workflow:');
  console.log('\n1. Founder Login (to assign tasks):');
  console.log(`   - Username: ${founderUsername}`);
  console.log('   - Password: password123');
  console.log('   - Go to: http://localhost:3000/founder');
  console.log('\n2. Worker Login (to view tasks & log checklists):');
  console.log(`   - Username: ${workerUsername}`);
  console.log('   - Password: password123');
  console.log('   - Go to: http://localhost:3000/worker');
  console.log('==================================================\n');

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
