import express from 'express';
import { query } from '../config/database.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Find a match for video call
router.post('/find-match', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get current user's info
    const userResult = await query(
      'SELECT id, name, gender, preferred_gender, is_premium, tokens FROM users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    const currentUser = userResult.rows[0];
    
    // Check if user has an active match already
    const activeMatchResult = await query(
      `SELECT id, user1_id, user2_id, status FROM matches 
       WHERE (user1_id = $1 OR user2_id = $1) AND status IN ('waiting', 'connected')`,
      [userId]
    );
    
    if (activeMatchResult.rows.length > 0) {
      const match = activeMatchResult.rows[0];
      const partnerId = match.user1_id === userId ? match.user2_id : match.user1_id;
      
      // Get partner info
      const partnerResult = await query(
        'SELECT id, name, gender, age, country, avatar_url, is_premium FROM users WHERE id = $1',
        [partnerId]
      );
      
      return res.json({
        success: true,
        message: 'You already have an active match',
        data: {
          matchId: match.id,
          status: match.status,
          partner: partnerResult.rows[0] || null,
          isExistingMatch: true
        }
      });
    }
    
    let matchQuery = '';
    let matchParams = [];
    
    // Premium users get gender-aware matching
    if (currentUser.is_premium && currentUser.preferred_gender) {
      console.log(`🎯 Premium user ${currentUser.name} searching for ${currentUser.preferred_gender} partners`);
      
      matchQuery = `
        SELECT id, name, gender, age, country, avatar_url, is_premium, tokens
        FROM users 
        WHERE id != $1 
          AND is_online = true 
          AND gender = $2
          AND id NOT IN (
            SELECT CASE 
              WHEN user1_id = $1 THEN user2_id 
              ELSE user1_id 
            END 
            FROM matches 
            WHERE (user1_id = $1 OR user2_id = $1) 
              AND status IN ('waiting', 'connected')
          )
        ORDER BY 
          CASE WHEN is_premium = true THEN 0 ELSE 1 END,
          RANDOM()
        LIMIT 1
      `;
      matchParams = [userId, currentUser.preferred_gender];
    } else {
      // Free users get random matching
      console.log(`🎲 Free user ${currentUser.name} searching for random partners`);
      
      matchQuery = `
        SELECT id, name, gender, age, country, avatar_url, is_premium, tokens
        FROM users 
        WHERE id != $1 
          AND is_online = true 
          AND id NOT IN (
            SELECT CASE 
              WHEN user1_id = $1 THEN user2_id 
              ELSE user1_id 
            END 
            FROM matches 
            WHERE (user1_id = $1 OR user2_id = $1) 
              AND status IN ('waiting', 'connected')
          )
        ORDER BY RANDOM()
        LIMIT 1
      `;
      matchParams = [userId];
    }
    
    // Find potential match
    const potentialMatchResult = await query(matchQuery, matchParams);
    
    if (potentialMatchResult.rows.length === 0) {
      return res.json({
        success: false,
        message: 'No users available for matching at the moment. Please try again later.',
        data: {
          searchCriteria: currentUser.is_premium ? currentUser.preferred_gender : 'any gender',
          isPremium: currentUser.is_premium
        }
      });
    }
    
    const matchedUser = potentialMatchResult.rows[0];
    
    // Create match record
    const newMatchResult = await query(
      `INSERT INTO matches (user1_id, user2_id, status, created_at) 
       VALUES ($1, $2, 'waiting', CURRENT_TIMESTAMP) 
       RETURNING id, status, created_at`,
      [userId, matchedUser.id]
    );
    
    const newMatch = newMatchResult.rows[0];
    
    console.log(`✨ Match created: ${currentUser.name} (${currentUser.is_premium ? 'PREMIUM' : 'FREE'}) ↔️ ${matchedUser.name} (${matchedUser.is_premium ? 'PREMIUM' : 'FREE'})`);
    
    res.json({
      success: true,
      message: 'Match found! Connecting you now...',
      data: {
        matchId: newMatch.id,
        status: newMatch.status,
        partner: {
          id: matchedUser.id,
          name: matchedUser.name,
          gender: matchedUser.gender,
          age: matchedUser.age,
          country: matchedUser.country,
          avatar_url: matchedUser.avatar_url,
          is_premium: matchedUser.is_premium
        },
        searchCriteria: currentUser.is_premium && currentUser.preferred_gender ? 
          currentUser.preferred_gender : 'any gender',
        isExistingMatch: false
      }
    });
    
  } catch (error) {
    console.error('Find match error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to find a match'
    });
  }
});

// End current match
router.post('/end-match/:matchId', authenticateToken, async (req, res) => {
  try {
    const { matchId } = req.params;
    const userId = req.user.id;
    
    // Verify user is part of this match
    const matchResult = await query(
      'SELECT id, user1_id, user2_id, status FROM matches WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)',
      [matchId, userId]
    );
    
    if (matchResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Match not found or you are not authorized to end this match'
      });
    }
    
    const match = matchResult.rows[0];
    
    if (match.status === 'ended') {
      return res.json({
        success: true,
        message: 'Match was already ended'
      });
    }
    
    // End the match
    await query(
      'UPDATE matches SET status = $1, ended_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['ended', matchId]
    );
    
    console.log(`🏁 Match ${matchId} ended by user ${userId}`);
    
    res.json({
      success: true,
      message: 'Match ended successfully'
    });
    
  } catch (error) {
    console.error('End match error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to end match'
    });
  }
});

// Get current match status
router.get('/current-match', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get active match
    const matchResult = await query(
      `SELECT id, user1_id, user2_id, status, created_at FROM matches 
       WHERE (user1_id = $1 OR user2_id = $1) AND status IN ('waiting', 'connected')
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    
    if (matchResult.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          hasActiveMatch: false,
          match: null
        }
      });
    }
    
    const match = matchResult.rows[0];
    const partnerId = match.user1_id === userId ? match.user2_id : match.user1_id;
    
    // Get partner info
    const partnerResult = await query(
      'SELECT id, name, gender, age, country, avatar_url, is_premium FROM users WHERE id = $1',
      [partnerId]
    );
    
    res.json({
      success: true,
      data: {
        hasActiveMatch: true,
        match: {
          id: match.id,
          status: match.status,
          createdAt: match.created_at,
          partner: partnerResult.rows[0] || null
        }
      }
    });
    
  } catch (error) {
    console.error('Get current match error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get current match status'
    });
  }
});

// Update match status (for when call connects)
router.put('/update-status/:matchId', authenticateToken, async (req, res) => {
  try {
    const { matchId } = req.params;
    const { status } = req.body;
    const userId = req.user.id;
    
    if (!['connected', 'ended'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be "connected" or "ended"'
      });
    }
    
    // Verify user is part of this match
    const matchResult = await query(
      'SELECT id, user1_id, user2_id, status FROM matches WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)',
      [matchId, userId]
    );
    
    if (matchResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Match not found or unauthorized'
      });
    }
    
    // Update match status
    const updateField = status === 'connected' ? 'connected_at' : 'ended_at';
    await query(
      `UPDATE matches SET status = $1, ${updateField} = CURRENT_TIMESTAMP WHERE id = $2`,
      [status, matchId]
    );
    
    console.log(`📱 Match ${matchId} status updated to: ${status}`);
    
    res.json({
      success: true,
      message: `Match status updated to ${status}`,
      data: {
        matchId,
        status
      }
    });
    
  } catch (error) {
    console.error('Update match status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update match status'
    });
  }
});

export default router;
