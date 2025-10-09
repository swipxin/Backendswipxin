import express from 'express';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import { query } from '../config/database.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';
import crypto from 'crypto';
import nodemailer from 'nodemailer';

// Real email sender using nodemailer
async function sendVerificationEmail(email, code) {
  const transporter = nodemailer.createTransport({
    host: 'smtp.zoho.in',
    port: 465,
    secure: true, // SSL
    auth: {
      user: 'noreply@swipx.in',
      pass: 'Ritikyadav@123'
    }
  });

  const mailOptions = {
    from: 'your-email@gmail.com', // Replace with your email
    to: email,
    subject: 'SwipX Email Verification',
    text: `Your verification code is: ${code}`
  };

  await transporter.sendMail(mailOptions);
  console.log(`📧 Verification email sent to ${email}`);
}
const router = express.Router();

// ============================================
// VALIDATION RULES
// ============================================

const registerValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required'),
  body('password')
    .isLength({ min: 6, max: 50 })
    .withMessage('Password must be at least 6 characters'),
  body('name')
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters'),
  body('age')
    .isInt({ min: 18, max: 100 })
    .withMessage('Age must be between 18 and 100'),
  body('gender')
    .isIn(['male', 'female', 'other'])
    .withMessage('Gender must be male, female, or other')
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
// EMAIL AVAILABILITY CHECK
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
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    const isAvailable = result.rows.length === 0;

    res.json({
      success: true,
      available: isAvailable,
      message: isAvailable ? 'Email available' : 'Email already taken'
    });

  } catch (error) {
    console.error('Email check error:', error);
    res.status(500).json({
      success: false,
      message: 'Check failed'
    });
  }
});

// ============================================
// REGISTER ENDPOINT (MINIMAL COLUMNS)
// ============================================

router.post('/register', registerValidation, async (req, res) => {
  try {
    console.log('📝 Registration request:', {
      email: req.body.email,
      name: req.body.name,
      age: req.body.age,
      gender: req.body.gender
    });

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('⚠️ Validation errors:', errors.array());
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

  const { email, password, name, age, country, gender } = req.body;

  // Set default country
  const userCountry = country || 'Unknown';

    // Check if user exists
    const existingUser = await query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (existingUser.rows.length > 0) {
      console.log('⚠️ Email already exists:', email);
      return res.status(409).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

  // Hash password
  const saltRounds = 12;
  const passwordHash = await bcrypt.hash(password, saltRounds);

  // Generate verification code
  const verificationCode = crypto.randomBytes(3).toString('hex');

    console.log('💾 Inserting user into database...');

    // ✅ MINIMAL INSERT - ONLY CORE COLUMNS + is_verified + verification_code
    const result = await query(
      `INSERT INTO users (email, password_hash, name, age, country, gender, is_verified, verification_code) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
       RETURNING *`,
      [
        email.toLowerCase().trim(),
        passwordHash,
        name.trim(),
        age,
        userCountry,
        gender,
        false,
        verificationCode
      ]
    );

    // Send verification email
    await sendVerificationEmail(email, verificationCode);

    const user = result.rows[0];

    // Remove sensitive data
    delete user.password_hash;
    delete user.verification_code;

    console.log(`✅ User registered successfully: ${user.name} (ID: ${user.id})`);

    res.status(201).json({
      success: true,
      message: 'Account created! Please check your email for verification code.',
      data: {
        user
      }
    });
// ============================================
// VERIFY ENDPOINT
// ============================================

router.post('/verify', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ success: false, message: 'Email and code required' });
    }
    const result = await query('SELECT id, is_verified, verification_code FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const user = result.rows[0];
    if (user.is_verified) {
      return res.json({ success: true, message: 'Already verified' });
    }
    if (user.verification_code !== code) {
      return res.status(400).json({ success: false, message: 'Invalid verification code' });
    }
    await query('UPDATE users SET is_verified = true, verification_code = NULL WHERE id = $1', [user.id]);
    return res.json({ success: true, message: 'Email verified successfully!' });
  } catch (error) {
    console.error('Verify error:', error);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

  } catch (error) {
    console.error('❌ Registration error:', error);
    console.error('Error message:', error.message);
    console.error('Error code:', error.code);
    console.error('Error detail:', error.detail);

    // Duplicate email error
    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Registration failed. Please try again.'
    });
  }
});

// ============================================
// LOGIN ENDPOINT
// ============================================

router.post('/login', loginValidation, async (req, res) => {
  try {
    console.log('🔐 Login attempt:', req.body.email);

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
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
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
        'UPDATE users SET is_premium = $1, preferred_gender = $2 WHERE id = $3',
        [false, null, user.id]
      );
      user.is_premium = false;
      user.preferred_gender = null;
      console.log(`📉 User ${user.name} downgraded to FREE`);
    }

    // Update online status
    await query(
      'UPDATE users SET is_online = $1, last_seen = CURRENT_TIMESTAMP WHERE id = $2',
      [true, user.id]
    );

    // Generate token
    const token = generateToken(user.id);

    // Remove sensitive data
    delete user.password_hash;
    user.is_online = true;
    user.last_seen = new Date().toISOString();

    console.log(`✅ Login successful: ${user.name}`);

    res.json({
      success: true,
      message: 'Login successful! Welcome back!',
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
      'SELECT * FROM users WHERE id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = result.rows[0];
    delete user.password_hash;

    res.json({
      success: true,
      data: {
        user
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

// ============================================
// UPDATE USER PROFILE
// ============================================

router.put('/profile', authenticateToken, [
  body('name').optional().trim().isLength({ min: 2, max: 100 }),
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
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
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
       RETURNING *`,
      values
    );

    const user = result.rows[0];
    delete user.password_hash;

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        user
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

// ============================================
// LOGOUT ENDPOINT
// ============================================

router.post('/logout', authenticateToken, async (req, res) => {
  try {
    await query(
      'UPDATE users SET is_online = $1, last_seen = CURRENT_TIMESTAMP WHERE id = $2',
      [false, req.user.id]
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

// ============================================
// PURCHASE PREMIUM PLAN
// ============================================

router.post('/purchase-premium', authenticateToken, [
  body('plan').isIn(['basic', 'pro', 'unlimited']).withMessage('Invalid plan type'),
  body('preferredGender').optional().isIn(['male', 'female', 'other'])
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

    const result = await query(
      `UPDATE users SET 
        is_premium = $1, 
        tokens = tokens + $2, 
        preferred_gender = $3,
        premium_expiry = CURRENT_TIMESTAMP + INTERVAL '30 days'
       WHERE id = $4 
       RETURNING id, email, name, tokens, is_premium, preferred_gender, premium_expiry`,
      [true, selectedPlan.tokens, preferredGender || null, req.user.id]
    );

    console.log(`💎 User upgraded to PREMIUM (${plan}) - ${selectedPlan.tokens} tokens added`);

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

// ============================================
// DEDUCT TOKENS FOR VIDEO CALL
// ============================================

router.post('/deduct-tokens', authenticateToken, async (req, res) => {
  try {
    const tokenCost = 8;

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

    const updateResult = await query(
      `UPDATE users SET 
        tokens = tokens - $1,
        total_calls = total_calls + 1
       WHERE id = $2 
       RETURNING tokens, total_calls`,
      [tokenCost, req.user.id]
    );

    const remainingTokens = updateResult.rows[0].tokens;

    if (remainingTokens <= 0) {
      await query(
        'UPDATE users SET is_premium = $1, preferred_gender = $2 WHERE id = $3',
        [false, null, req.user.id]
      );
      console.log(`📉 User auto-downgraded to FREE`);
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

// ============================================
// GET USER STATISTICS
// ============================================

router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const userStats = await query(
      'SELECT total_calls, tokens, is_premium, created_at FROM users WHERE id = $1',
      [req.user.id]
    );

    const transactions = await query(
      'SELECT type, tokens, amount, description, created_at FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
      [req.user.id]
    );

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
