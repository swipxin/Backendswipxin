import express from 'express';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import { query } from '../config/database.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Validation rules
const registerValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters'),
  body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),
  body('age').isInt({ min: 18, max: 100 }).withMessage('Age must be between 18 and 100'),
  body('country').optional().trim().isLength({ min: 2, max: 100 }).withMessage('Country must be between 2 and 100 characters'),
  body('gender').isIn(['male', 'female', 'other']).withMessage('Gender must be male, female, or other'),
  body('preferredGender').optional().isIn(['male', 'female', 'other']).withMessage('Preferred gender must be male, female, or other')
];

const loginValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required')
];

// Register endpoint
router.post('/register', registerValidation, async (req, res) => {
  try {
    console.log('Registration request received:', req.body);
    
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Validation errors:', errors.array());
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email, password, name, age, country, gender, preferredGender } = req.body;
    
    // Set default country if not provided
    const userCountry = country || 'Unknown';

    // Check if user already exists
    const existingUser = await query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create user with FREE account (0 tokens, no premium features)
    const result = await query(
      `INSERT INTO users (email, password_hash, name, age, country, gender, preferred_gender, tokens, is_premium, is_online) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, false, true) 
       RETURNING id, email, name, age, country, gender, preferred_gender, avatar_url, is_premium, tokens, is_online, total_calls, created_at`,
      [email, passwordHash, name, age, userCountry, gender, null] // Free users get no gender preference
    );

    const user = result.rows[0];

    // Create welcome transaction for FREE account
    await query(
      'INSERT INTO transactions (user_id, type, tokens, description) VALUES ($1, $2, $3, $4)',
      [user.id, 'signup', 0, 'Free account created - upgrade to premium for tokens!']
    );

    // Generate token
    const token = generateToken(user.id);

    // Remove sensitive data from response
    delete user.password_hash;

    res.status(201).json({
      success: true,
      message: 'Account created successfully! Welcome to SwipX!',
      data: {
        user,
        token
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Registration failed. Please try again.'
    });
  }
});

// Login endpoint
router.post('/login', loginValidation, async (req, res) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email, password } = req.body;

    // Get user from database
    const result = await query(
      'SELECT id, email, password_hash, name, age, country, gender, preferred_gender, avatar_url, is_premium, tokens, is_online, last_seen, total_calls, created_at FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const user = result.rows[0];

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    // Check if premium user has 0 tokens - downgrade to free
    if (user.is_premium && user.tokens <= 0) {
      await query(
        'UPDATE users SET is_premium = false, preferred_gender = null WHERE id = $1',
        [user.id]
      );
      user.is_premium = false;
      user.preferred_gender = null;
      console.log(`📉 User ${user.name} (${user.email}) downgraded to FREE - 0 tokens remaining`);
      
      // Log downgrade transaction
      await query(
        'INSERT INTO transactions (user_id, type, tokens, description) VALUES ($1, $2, $3, $4)',
        [user.id, 'downgrade', 0, 'Downgraded to FREE - premium tokens exhausted']
      );
    }

    // Update online status
    await query(
      'UPDATE users SET is_online = true, last_seen = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    // Generate token
    const token = generateToken(user.id);

    // Remove sensitive data from response
    delete user.password_hash;
    user.is_online = true;
    user.last_seen = new Date().toISOString();

    res.json({
      success: true,
      message: 'Login successful! Welcome back!',
      data: {
        user,
        token
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed. Please try again.'
    });
  }
});

// Get current user profile
router.get('/me', authenticateToken, async (req, res) => {
  try {
    // Get fresh user data from database
    const result = await query(
      'SELECT id, email, name, age, country, gender, preferred_gender, avatar_url, bio, interests, is_premium, tokens, subscription_expires_at, premium_expiry, is_online, last_seen, total_calls, created_at FROM users WHERE id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      data: {
        user: result.rows[0]
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get user profile'
    });
  }
});

// Update user profile
router.put('/profile', authenticateToken, [
  body('name').optional().trim().isLength({ min: 2, max: 100 }),
  body('age').optional().isInt({ min: 18, max: 100 }),
  body('country').optional().trim().isLength({ min: 2, max: 100 }),
  body('gender').optional().isIn(['male', 'female', 'other']),
  body('preferredGender').optional().isIn(['male', 'female', 'other']),
  body('bio').optional().trim().isLength({ max: 500 }),
  body('interests').optional().isArray({ max: 10 }),
  body('tokens').optional().isInt({ min: 0 }).withMessage('Tokens must be a non-negative integer')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const updates = {};
    const allowedFields = ['name', 'age', 'country', 'gender', 'preferred_gender', 'bio', 'interests', 'tokens'];
    
    // Build update object with only provided fields
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields provided for update'
      });
    }

    // Build SQL query dynamically
    const setClause = Object.keys(updates).map((key, index) => 
      `${key} = $${index + 2}`
    ).join(', ');

    const values = [req.user.id, ...Object.values(updates)];

    const result = await query(
      `UPDATE users SET ${setClause}, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 
       RETURNING id, email, name, age, country, gender, preferred_gender, avatar_url, bio, interests, is_premium, tokens, subscription_expires_at, premium_expiry, is_online, last_seen, total_calls, updated_at`,
      values
    );

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        user: result.rows[0]
      }
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update profile'
    });
  }
});

// Logout endpoint (update online status)
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    // Update offline status
    await query(
      'UPDATE users SET is_online = false, last_seen = CURRENT_TIMESTAMP WHERE id = $1',
      [req.user.id]
    );

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      message: 'Logout failed'
    });
  }
});

// Purchase Premium Plan
router.post('/purchase-premium', authenticateToken, [
  body('plan').isIn(['basic', 'pro', 'unlimited']).withMessage('Invalid plan type'),
  body('preferredGender').optional().isIn(['male', 'female', 'other']).withMessage('Invalid preferred gender')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { plan, preferredGender } = req.body;
    
    // Define plan details
    const planDetails = {
      basic: { tokens: 100, price: 9.99, description: 'Basic Plan - 100 tokens' },
      pro: { tokens: 300, price: 24.99, description: 'Pro Plan - 300 tokens' },
      unlimited: { tokens: 1000, price: 49.99, description: 'Unlimited Plan - 1000 tokens' }
    };
    
    const selectedPlan = planDetails[plan];
    if (!selectedPlan) {
      return res.status(400).json({
        success: false,
        message: 'Invalid plan selected'
      });
    }

    // Update user to premium with tokens and preferred gender
    const result = await query(
      `UPDATE users SET 
        is_premium = true, 
        tokens = tokens + $1, 
        preferred_gender = $2,
        premium_expiry = CURRENT_TIMESTAMP + INTERVAL '30 days'
       WHERE id = $3 
       RETURNING id, email, name, tokens, is_premium, preferred_gender, premium_expiry`,
      [selectedPlan.tokens, preferredGender || null, req.user.id]
    );

    // Log purchase transaction
    await query(
      'INSERT INTO transactions (user_id, type, tokens, amount, description) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, 'purchase', selectedPlan.tokens, selectedPlan.price, selectedPlan.description]
    );

    console.log(`💎 User ${result.rows[0].name} upgraded to PREMIUM (${plan}) - ${selectedPlan.tokens} tokens added`);

    res.json({
      success: true,
      message: `Premium ${plan} plan activated! You now have ${result.rows[0].tokens} tokens.`,
      data: {
        user: result.rows[0],
        plan: selectedPlan
      }
    });

  } catch (error) {
    console.error('Premium purchase error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process premium purchase'
    });
  }
});

// Deduct tokens for video call
router.post('/deduct-tokens', authenticateToken, async (req, res) => {
  try {
    const tokenCost = 8; // Cost per video call connection
    
    // Get current user tokens
    const userResult = await query(
      'SELECT tokens, is_premium FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    const user = userResult.rows[0];
    
    // Check if user is premium and has enough tokens
    if (!user.is_premium) {
      return res.status(403).json({
        success: false,
        message: 'Premium subscription required for video calls'
      });
    }
    
    if (user.tokens < tokenCost) {
      return res.status(402).json({
        success: false,
        message: 'Insufficient tokens. Please purchase more tokens to continue.',
        tokensNeeded: tokenCost,
        currentTokens: user.tokens
      });
    }
    
    // Deduct tokens
    const updateResult = await query(
      `UPDATE users SET 
        tokens = tokens - $1,
        total_calls = total_calls + 1
       WHERE id = $2 
       RETURNING tokens, total_calls`,
      [tokenCost, req.user.id]
    );
    
    // Log token deduction transaction
    await query(
      'INSERT INTO transactions (user_id, type, tokens, description) VALUES ($1, $2, $3, $4)',
      [req.user.id, 'call', -tokenCost, 'Video call connection - 8 tokens deducted']
    );
    
    const remainingTokens = updateResult.rows[0].tokens;
    
    // Check if user should be downgraded to free
    if (remainingTokens <= 0) {
      await query(
        'UPDATE users SET is_premium = false, preferred_gender = null WHERE id = $1',
        [req.user.id]
      );
      
      await query(
        'INSERT INTO transactions (user_id, type, tokens, description) VALUES ($1, $2, $3, $4)',
        [req.user.id, 'downgrade', 0, 'Auto-downgraded to FREE - tokens exhausted']
      );
      
      console.log(`📉 User auto-downgraded to FREE - 0 tokens remaining`);
    }
    
    res.json({
      success: true,
      message: `${tokenCost} tokens deducted for video call`,
      data: {
        tokensDeducted: tokenCost,
        remainingTokens: remainingTokens,
        totalCalls: updateResult.rows[0].total_calls,
        isPremium: remainingTokens > 0
      }
    });

  } catch (error) {
    console.error('Token deduction error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to deduct tokens'
    });
  }
});

// Get user statistics
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    // Get user stats
    const userStats = await query(
      'SELECT total_calls, tokens, is_premium, created_at FROM users WHERE id = $1',
      [req.user.id]
    );

    // Get transaction history
    const transactions = await query(
      'SELECT type, tokens, amount, description, created_at FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
      [req.user.id]
    );

    // Get match history count
    const matchHistory = await query(
      'SELECT COUNT(*) as total_matches FROM matches WHERE (user1_id = $1 OR user2_id = $1) AND status = $2',
      [req.user.id, 'ended']
    );

    res.json({
      success: true,
      data: {
        stats: userStats.rows[0],
        recentTransactions: transactions.rows,
        totalMatches: parseInt(matchHistory.rows[0].total_matches)
      }
    });

  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get user statistics'
    });
  }
});

export default router;
