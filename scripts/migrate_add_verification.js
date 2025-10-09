import { query } from '../config/database.js';

async function migrate() {
  try {
    await query(`ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false, 
      ADD COLUMN IF NOT EXISTS verification_code VARCHAR(20);
    `);
    console.log('✅ Migration: is_verified and verification_code columns added to users table');
  } catch (error) {
    console.error('❌ Migration error:', error);
  }
}

migrate();
