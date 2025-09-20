import bcrypt from 'bcryptjs';
import { query } from '../config/database.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const dummyUsers = [
  {
    name: 'John Doe',
    email: 'john@example.com',
    password: 'password123',
    age: 25,
    country: 'USA',
    gender: 'male',
    preferred_gender: 'female',
    bio: 'Love traveling and meeting new people!'
  },
  {
    name: 'Jane Smith',
    email: 'jane@example.com',
    password: 'password123',
    age: 23,
    country: 'Canada',
    gender: 'female',
    preferred_gender: 'male',
    bio: 'Coffee enthusiast and adventure seeker.'
  },
  {
    name: 'Alex Johnson',
    email: 'alex@example.com',
    password: 'password123',
    age: 28,
    country: 'UK',
    gender: 'other',
    preferred_gender: null,
    bio: 'Artist and music lover. Open to all connections!'
  },
  {
    name: 'Maria Garcia',
    email: 'maria@example.com',
    password: 'password123',
    age: 26,
    country: 'Spain',
    gender: 'female',
    preferred_gender: 'female',
    bio: 'Yoga instructor and nature lover.'
  },
  {
    name: 'David Kim',
    email: 'david@example.com',
    password: 'password123',
    age: 30,
    country: 'South Korea',
    gender: 'male',
    preferred_gender: null,
    bio: 'Tech enthusiast and gamer. Always up for a chat!'
  },
  {
    name: 'Test User',
    email: 'test@test.com',
    password: 'test123',
    age: 25,
    country: 'India',
    gender: 'male',
    preferred_gender: null,
    bio: 'Test account for development'
  }
];

async function seedDatabase() {
  console.log('🌱 Starting database seeding...');

  try {
    // Check if any users already exist to avoid duplicates
    const existingUsers = await query('SELECT COUNT(*) as count FROM users');
    const userCount = parseInt(existingUsers.rows[0].count);

    if (userCount > 0) {
      console.log(`📊 Database already has ${userCount} users.`);
      console.log('🤔 Do you want to continue adding dummy users? (This might create duplicates)');
      
      // For automated seeding, we'll skip if users exist
      // You can comment out this return statement if you want to force seeding
      console.log('⏭️  Skipping seeding as users already exist.');
      console.log('💡 To force seeding, comment out the return statement in seed.js');
      return;
    }

    let successCount = 0;
    let skipCount = 0;

    for (const userData of dummyUsers) {
      try {
        // Check if user already exists
        const existingUser = await query(
          'SELECT id FROM users WHERE email = $1',
          [userData.email]
        );

        if (existingUser.rows.length > 0) {
          console.log(`⚠️  User ${userData.email} already exists, skipping...`);
          skipCount++;
          continue;
        }

        // Hash password
        const saltRounds = 12;
        const passwordHash = await bcrypt.hash(userData.password, saltRounds);

        // Insert user
        const result = await query(
          `INSERT INTO users (
            email, password_hash, name, age, country, gender, preferred_gender, bio, tokens, is_online
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
          RETURNING id, email, name`,
          [
            userData.email,
            passwordHash,
            userData.name,
            userData.age,
            userData.country,
            userData.gender,
            userData.preferred_gender,
            userData.bio,
            100, // Starting tokens
            false // Initially offline
          ]
        );

        const user = result.rows[0];

        // Create welcome transaction
        await query(
          'INSERT INTO transactions (user_id, type, tokens, description) VALUES ($1, $2, $3, $4)',
          [user.id, 'bonus', 100, 'Welcome bonus - 100 free tokens!']
        );

        console.log(`✅ Created user: ${user.name} (${user.email}) - ID: ${user.id}`);
        successCount++;

      } catch (userError) {
        console.error(`❌ Failed to create user ${userData.email}:`, userError.message);
      }
    }

    console.log('\n📈 Seeding Summary:');
    console.log(`✅ Successfully created: ${successCount} users`);
    console.log(`⚠️  Skipped (already exist): ${skipCount} users`);
    console.log(`🎯 Total attempted: ${dummyUsers.length} users`);

    if (successCount > 0) {
      console.log('\n🔐 Test Login Credentials:');
      console.log('Email: test@test.com | Password: test123');
      console.log('Email: john@example.com | Password: password123');
      console.log('Email: jane@example.com | Password: password123');
    }

  } catch (error) {
    console.error('💥 Database seeding failed:', error);
    process.exit(1);
  }
}

// Self-executing function
(async () => {
  try {
    await seedDatabase();
    console.log('\n🎉 Database seeding completed!');
    process.exit(0);
  } catch (error) {
    console.error('💥 Seeding process failed:', error);
    process.exit(1);
  }
})();
