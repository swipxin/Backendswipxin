import express from 'express';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import { query } from '../config/database.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// ============================================
// VALIDATION RULES
// ============================================

const registerValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required')
    .custom(async (email) => {
      const result = await query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      if (result.rows.length > 0) {
        throw new Error('Email already registered');
      }
      return true;
    }),
  body('password')
    .isLength({ min: 6, max: 50 })
    .withMessage('Password must be between 6 and 50 characters')
    .matches(/^(?=.*[a-zA-Z])(?=.*[0-9])/)
    .withMessage('Password must contain at least one letter and one number'),
  body('name')
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2 and 50 characters')
    .matches(/^[a-zA-Z\s]+$/)
    .withMessage('Name can only contain letters and spaces'),
  body('age')
    .isInt({ min: 18, max: 100 })
    .withMessage('Age must be between 18 and 100'),
  body('country')
    .optional()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Country must be between 2 and 100 characters'),
  body('gender')
    .isIn(['male', 'female', 'other'])
    .withMessage('Gender must be male, female, or other'),
  body('preferredGender')
    .optional()
    .isIn(['male', 'female', 'other'])
    .withMessage('Preferred gender must be male, female, or other')
];

const loginValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required'),
  body('password')
    .notEmpty()
    .withMessage('Password is required')
];

// ============================================
// ✅ NEW: EMAIL AVAILABILITY CHECK (REAL-TIME)
// ============================================

router.post('/check-email', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email required'
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.json({
        success: false,
        available: false,
        message: 'Invalid email format'
      });
    }

    const result = await query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [email.trim()]
    );

    const isAvailable = result.rows.length === 0;

    res.json({
      success: true,
      available: isAvailable,
      message: isAvailable ? '✅ Email available' : '❌ Email already taken'
    });

  } catch (error) {
    console.error('❌ Email check error:', error);
    res.status(500).json({
      success: false,
      message: 'Check failed'
    });
  }
});

// ============================================
// REGISTER ENDPOINT (ENHANCED)
// ============================================

router.post('/register', registerValidation, async (req, res) => {
  try {
    console.log('📝 Registration attempt:', {
      email: req.body.email,
      name: req.body.name,
      age: req.body.age,
      gender: req.body.gender
    });

    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('⚠️ Validation errors:', errors.array());
      
      // Format errors for frontend
      const formattedErrors = {};
      errors.array().forEach(error => {
        formattedErrors[error.path || error.param] = error.msg;
      });

      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: formattedErrors
      });
    }

    const { email, password, name, age, country, gender, preferredGender } = req.body;

    // Set default country if not provided
    const userCountry = country || 'Unknown';

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create user with FREE account
    const result = await query(
      `INSERT INTO users (
        email, password_hash, name, age, country, gender, preferred_gender, 
        tokens, is_premium, is_online, created_at
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, 0, false, true, CURRENT_TIMESTAMP) 
      RETURNING id, email, name, age, country, gender, preferred_gender, 
                avatar_url, is_premium, tokens, is_online, total_calls, created_at`,
      [email.toLowerCase().trim(), passwordHash, name.trim(), age, userCountry, gender, null]
    );

    const user = result.rows[0];

    // Create welcome transaction
    await query(
      'INSERT INTO transactions (user_id, type, tokens, description) VALUES ($1, $2, $3, $4)',
      [user.id, 'signup', 0, 'Free account created - upgrade to premium for filters and tokens!']
    );

    // Generate JWT token
    const token = generateToken(user.id);

    console.log(`✅ Registration successful: ${user.name} (${user.email})`);

    res.status(201).json({
      success: true,
      message: '🎉 Account created successfully! Welcome to SwipX!',
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          age: user.age,
          country: user.country,
          gender: user.gender,
          avatar_url: user.avatar_url,
          is_premium: user.is_premium,
          tokens: user.tokens,
          is_online: user.is_online,
          created_at: user.created_at
        },
        token
      }
    });

  } catch (error) {
    console.error('❌ Registration error:', error);

    // Handle specific database errors
    if (error.code === '23505') { // Unique violation
      return res.status(409).json({
        success: false,
        message: 'Email already registered',
        errors: { email: 'This email is already taken' }
      });
    }

    res.status(500).json({
      success: false,
      message: 'Registration failed. Please try again.'
    });
  }
});

// ============================================
// LOGIN ENDPOINT (ENHANCED)
// ============================================

router.post('/login', loginValidation, async (req, res) => {
  try {
    console.log('🔐 Login attempt:', req.body.email);

    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const formattedErrors = {};
      errors.array().forEach(error => {
        formattedErrors[error.path || error.param] = error.msg;
      });

      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: formattedErrors
      });
    }

    const { email, password } = req.body;

    // Get user from database
    const result = await query(
      `SELECT id, email, password_hash, name, age, country, gender, preferred_gender, 
              avatar_url, is_premium, tokens, is_online, last_seen, total_calls, created_at 
       FROM users WHERE LOWER(email) = LOWER($1)`,
      [email.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
        errors: { email: 'No account found with this email' }
      });
    }

    const user = result.rows[0];

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
        errors: { password: 'Incorrect password' }
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
      
      console.log(`📉 User ${user.name} downgraded to FREE - 0 tokens`);

      await query(
        'INSERT INTO transactions (user_id, type, tokens, description) VALUES ($1, $2, $3, $4)',
        [user.id, 'downgrade', 0, 'Auto-downgraded to FREE - premium tokens exhausted']
      );
    }

    // Update online status
    await query(
      'UPDATE users SET is_online = true, last_seen = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    // Generate token
    const token = generateToken(user.id);

    // Remove sensitive data
    delete user.password_hash;
    user.is_online = true;
    user.last_seen = new Date().toISOString();

    console.log(`✅ Login successful: ${user.name} (${user.email})`);

    res.json({
      success: true,
      message: '🎉 Login successful! Welcome back!',
      data: {
        user,
        token
      }
    });

  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed. Please try again.'
    });
  }
});

// ============================================
// GET CURRENT USER PROFILE
// ============================================

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, email, name, age, country, gender, preferred_gender, avatar_url, bio, interests, 
              is_premium, tokens, subscription_expires_at, premium_expiry, is_online, last_seen, 
              total_calls, created_at 
       FROM users WHERE id = $1`,
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
    console.error('❌ Get profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get user profile'
    });
  }
});

// ============================================
// UPDATE USER PROFILE
// ============================================

router.put('/profile', authenticateToken, [
  body('name').optional().trim().isLength({ min: 2, max: 50 }),
  body('age').optional().isInt({ min: 18, max: 100 }),
  body('country').optional().trim().isLength({ min: 2, max: 100 }),
  body('gender').optional().isIn(['male', 'female', 'other']),
  body('preferredGender').optional().isIn(['male', 'female', 'other']),
  body('bio').optional().trim().isLength({ max: 500 }),
  body('interests').optional().isArray({ max: 10 }),
  body('tokens').optional().isInt({ min: 0 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const formattedErrors = {};
      errors.array().forEach(error => {
        formattedErrors[error.path || error.param] = error.msg;
      });

      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: formattedErrors
      });
    }

    const updates = {};
    const allowedFields = ['name', 'age', 'country', 'gender', 'preferred_gender', 'bio', 'interests', 'tokens'];

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

    const setClause = Object.keys(updates).map((key, index) =>
      `${key} = $${index + 2}`
    ).join(', ');

    const values = [req.user.id, ...Object.values(updates)];

    const result = await query(
      `UPDATE users SET ${setClause}, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 
       RETURNING id, email, name, age, country, gender, preferred_gender, avatar_url, bio, 
                 interests, is_premium, tokens, subscription_expires_at, premium_expiry, 
                 is_online, last_seen, total_calls, updated_at`,
      values
    );

    console.log(`✅ Profile updated: ${result.rows[0].name}`);

    res.json({
      success: true,
      message: '✅ Profile updated successfully',
      data: {
        user: result.rows[0]
      }
    });

  } catch (error) {
    console.error('❌ Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update profile'
    });
  }
});

// Keep all other endpoints (logout, purchase-premium, deduct-tokens, stats) as they are
// ... (rest of your existing code)

export default router;
