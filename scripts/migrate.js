import { query } from '../config/database.js';

const createTables = async () => {
  try {
    console.log('🚀 Starting database migration...');

    // Create extensions
    await query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    `);

    // Create enum types
    await query(`
      DO $$ BEGIN
        CREATE TYPE user_gender AS ENUM ('male', 'female', 'other');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await query(`
      DO $$ BEGIN
        CREATE TYPE match_status AS ENUM ('pending', 'active', 'ended', 'cancelled');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await query(`
      DO $$ BEGIN
        CREATE TYPE message_type AS ENUM ('text', 'system', 'emoji', 'image');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await query(`
      DO $$ BEGIN
        CREATE TYPE transaction_type AS ENUM ('purchase', 'bonus', 'deduction', 'refund');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    // Create users table
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        age INTEGER NOT NULL CHECK (age >= 18 AND age <= 100),
        country VARCHAR(100) NOT NULL,
        gender user_gender NOT NULL,
        preferred_gender user_gender,
        avatar_url TEXT,
        bio TEXT,
        interests TEXT[],
        is_premium BOOLEAN DEFAULT false,
        tokens INTEGER DEFAULT 50,
        subscription_expires_at TIMESTAMP,
        premium_expiry TIMESTAMP,
        is_online BOOLEAN DEFAULT false,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_calls INTEGER DEFAULT 0,
        is_verified BOOLEAN DEFAULT false,
        verification_token TEXT,
        reset_token TEXT,
        reset_expires TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create matches table
    await query(`
      CREATE TABLE IF NOT EXISTS matches (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user1_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user2_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status match_status DEFAULT 'pending',
        room_id VARCHAR(255) UNIQUE,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP,
        ended_by UUID REFERENCES users(id),
        rating_user1 INTEGER CHECK (rating_user1 >= 1 AND rating_user1 <= 5),
        rating_user2 INTEGER CHECK (rating_user2 >= 1 AND rating_user2 <= 5),
        duration_seconds INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT unique_active_match UNIQUE (user1_id, user2_id)
      );
    `);

    // Create messages table
    await query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        message_type message_type DEFAULT 'text',
        is_read BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create transactions table
    await query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type transaction_type NOT NULL,
        tokens INTEGER NOT NULL,
        amount DECIMAL(10, 2),
        description TEXT,
        reference_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create plans table
    await query(`
      CREATE TABLE IF NOT EXISTS plans (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(100) NOT NULL,
        description TEXT,
        price DECIMAL(10, 2) NOT NULL,
        tokens INTEGER NOT NULL,
        duration_days INTEGER,
        features TEXT[],
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create user_sessions table for active sessions tracking
    await query(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        socket_id VARCHAR(255),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create indexes for better performance
    await query(`
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_online ON users(is_online);
      CREATE INDEX IF NOT EXISTS idx_users_country_gender ON users(country, gender);
      CREATE INDEX IF NOT EXISTS idx_matches_users ON matches(user1_id, user2_id);
      CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
      CREATE INDEX IF NOT EXISTS idx_matches_room_id ON matches(room_id);
      CREATE INDEX IF NOT EXISTS idx_messages_match ON messages(match_id);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_sessions_socket ON user_sessions(socket_id);
    `);

    // Create triggers for updated_at timestamps
    await query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
      END;
      $$ language 'plpgsql';
    `);

    await query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_users_updated_at') THEN
          CREATE TRIGGER update_users_updated_at 
            BEFORE UPDATE ON users 
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        END IF;
      END $$;
    `);

    await query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_matches_updated_at') THEN
          CREATE TRIGGER update_matches_updated_at 
            BEFORE UPDATE ON matches 
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        END IF;
      END $$;
    `);

    await query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_plans_updated_at') THEN
          CREATE TRIGGER update_plans_updated_at 
            BEFORE UPDATE ON plans 
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        END IF;
      END $$;
    `);

    await query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_user_sessions_updated_at') THEN
          CREATE TRIGGER update_user_sessions_updated_at 
            BEFORE UPDATE ON user_sessions 
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        END IF;
      END $$;
    `);

    // Create stored procedures for complex operations
    await query(`
      CREATE OR REPLACE FUNCTION find_available_match(
        p_user_id UUID,
        p_preferred_gender user_gender DEFAULT NULL
      )
      RETURNS TABLE (
        user_id UUID,
        name VARCHAR,
        age INTEGER,
        country VARCHAR,
        gender user_gender,
        avatar_url TEXT,
        is_premium BOOLEAN,
        tokens INTEGER
      ) AS $$
      BEGIN
        RETURN QUERY
        SELECT 
          u.id, u.name, u.age, u.country, u.gender, u.avatar_url, u.is_premium, u.tokens
        FROM users u
        WHERE u.id != p_user_id
          AND u.is_online = true
          AND u.tokens > 0
          AND (p_preferred_gender IS NULL OR u.gender = p_preferred_gender)
          AND u.id NOT IN (
            SELECT CASE WHEN m.user1_id = p_user_id THEN m.user2_id ELSE m.user1_id END
            FROM matches m
            WHERE (m.user1_id = p_user_id OR m.user2_id = p_user_id)
              AND m.status IN ('pending', 'active')
          )
        ORDER BY RANDOM()
        LIMIT 1;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await query(`
      CREATE OR REPLACE FUNCTION create_match_with_tokens(
        p_user1_id UUID,
        p_user2_id UUID
      )
      RETURNS UUID AS $$
      DECLARE
        v_match_id UUID;
        v_room_id VARCHAR(255);
      BEGIN
        -- Generate unique room ID
        v_room_id := 'room_' || EXTRACT(epoch FROM NOW())::bigint || '_' || (RANDOM() * 1000)::int;
        
        -- Create the match
        INSERT INTO matches (user1_id, user2_id, status, room_id)
        VALUES (p_user1_id, p_user2_id, 'active', v_room_id)
        RETURNING id INTO v_match_id;
        
        -- Deduct tokens from both users
        UPDATE users SET tokens = tokens - 1 WHERE id IN (p_user1_id, p_user2_id);
        
        -- Log transactions
        INSERT INTO transactions (user_id, type, tokens, description)
        VALUES 
          (p_user1_id, 'deduction', -1, 'Video call started'),
          (p_user2_id, 'deduction', -1, 'Video call started');
        
        RETURN v_match_id;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await query(`
      CREATE OR REPLACE FUNCTION end_match(
        p_match_id UUID,
        p_ended_by UUID
      )
      RETURNS BOOLEAN AS $$
      DECLARE
        v_duration INTEGER;
        v_started_at TIMESTAMP;
      BEGIN
        -- Get match details
        SELECT started_at INTO v_started_at
        FROM matches
        WHERE id = p_match_id;
        
        IF v_started_at IS NULL THEN
          RETURN false;
        END IF;
        
        -- Calculate duration in seconds
        v_duration := EXTRACT(epoch FROM (NOW() - v_started_at))::INTEGER;
        
        -- Update match
        UPDATE matches
        SET status = 'ended',
            ended_at = NOW(),
            ended_by = p_ended_by,
            duration_seconds = v_duration
        WHERE id = p_match_id AND status = 'active';
        
        -- Update user call counts
        UPDATE users
        SET total_calls = total_calls + 1
        WHERE id IN (
          SELECT user1_id FROM matches WHERE id = p_match_id
          UNION
          SELECT user2_id FROM matches WHERE id = p_match_id
        );
        
        RETURN true;
      END;
      $$ LANGUAGE plpgsql;
    `);

    console.log('✅ Database migration completed successfully!');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
};

// Run migration
createTables()
  .then(() => {
    console.log('🎉 All tables created successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Migration error:', error);
    process.exit(1);
  });
