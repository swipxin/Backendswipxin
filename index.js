import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { query } from './config/database.js';
import { socketAuth } from './middleware/auth.js';

import authRoutes from './routes/auth.js';
import matchingRoutes from './routes/matching.js';

const PORT = process.env.PORT || 5002;
const FRONTEND_URLS = [
  "https://app.swipx.in",
  "https://realswipxin-45ia.vercel.app",
  "http://localhost:3000"
];

const app = express();
app.set('trust proxy', 1);

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: FRONTEND_URLS,
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

app.use(cors({ origin: FRONTEND_URLS, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'SwipX Backend running', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/matching', matchingRoutes);

io.use(socketAuth);

// Store active users and their socket connections
const activeUsers = new Map(); // userId -> { socketId, user }
const waitingUsers = new Map(); // userId -> { user, preferences }
const activeMatches = new Map(); // matchId -> { user1Id, user2Id, roomId }
const rooms = new Map(); // roomId -> { participants: [socketId1, socketId2], matchId }

// Socket.IO connection handling
io.on('connection', async (socket) => {
  console.log(`✅ ${socket.user.name} connected (${socket.userId})`);
  
  // Add user to active users
  activeUsers.set(socket.userId, {
    socketId: socket.id,
    user: socket.user
  });

  // Update user online status in database
  try {
    await query('UPDATE users SET is_online = true, last_seen = CURRENT_TIMESTAMP WHERE id = $1', [socket.userId]);
  } catch (error) {
    console.error('Error updating user online status:', error);
  }

  // Emit online users count
  socket.broadcast.emit('userOnline', {
    userId: socket.userId,
    user: socket.user
  });

  // Handle user joining matching queue
  socket.on('joinMatchingQueue', async (preferences = {}) => {
    try {
      console.log(`🔍 User ${socket.user.name} joined matching queue with preferences:`, preferences);
      
      // Check if user has enough tokens
      if (socket.user.tokens < 1) {
        socket.emit('matchingError', {
          message: 'Insufficient tokens. You need at least 1 token to start a video call.'
        });
        return;
      }

      // Add user to waiting queue
      waitingUsers.set(socket.userId, {
        user: socket.user,
        preferences,
        socketId: socket.id,
        joinedAt: Date.now()
      });

      console.log(`📊 Queue size after adding ${socket.user.name}: ${waitingUsers.size}`);

      socket.emit('matchingStatus', {
        status: 'searching',
        message: 'Looking for a match...'
      });

      // Try to find a match immediately
      const matchFound = await findMatch(socket.userId);
      
      // If no match found, but there are multiple users in queue, 
      // try to process the entire queue to find any possible matches
      if (!matchFound && waitingUsers.size >= 2) {
        console.log(`🔄 No immediate match found, processing entire queue...`);
        await processMatchingQueue();
      }
      
      // Trigger matching for all waiting users when someone new joins
      if (waitingUsers.size >= 2) {
        setTimeout(async () => {
          console.log(`🔍 Auto-triggering match processing for ${waitingUsers.size} users...`);
          await processMatchingQueue();
        }, 1000); // Small delay to ensure all users are properly added to queue
      }

    } catch (error) {
      console.error('Error joining matching queue:', error);
      socket.emit('matchingError', {
        message: 'Failed to join matching queue'
      });
    }
  });

  socket.on('leaveMatchingQueue', () => {
    waitingUsers.delete(socket.userId);
    socket.emit('matchingStatus', {
      status: 'idle',
      message: 'Stopped searching for matches'
    });
    console.log(`🚨 User ${socket.user.name} left matching queue`);
  });

  // ================== WebRTC SIGNALING HANDLERS ==================
  
  // WebRTC Offer handler (from initiator)
  socket.on('webrtc-offer', (data) => {
    const { roomId, offer } = data;
    console.log(`📤 [WebRTC] Offer from ${socket.user.name} to room ${roomId}`);
    
    socket.to(roomId).emit('webrtc-offer', {
      offer: offer,
      from: socket.userId,
      fromName: socket.user.name
    });
  });

  // WebRTC Answer handler (from receiver)
  socket.on('webrtc-answer', (data) => {
    const { roomId, answer } = data;
    console.log(`📤 [WebRTC] Answer from ${socket.user.name} to room ${roomId}`);
    
    socket.to(roomId).emit('webrtc-answer', {
      answer: answer,
      from: socket.userId,
      fromName: socket.user.name
    });
  });

  // ICE Candidate handler
  socket.on('ice-candidate', (data) => {
    const { roomId, candidate } = data;
    console.log(`🧊 [WebRTC] ICE candidate from ${socket.user.name}`);
    
    socket.to(roomId).emit('ice-candidate', {
      candidate: candidate,
      from: socket.userId,
      fromName: socket.user.name
    });
  });

  // ================== NEXT MATCH & AUTO-RECONNECT HANDLERS ==================
  
  // Handle user skipping to next match
  socket.on('skipMatch', async (data) => {
    const { roomId, matchId, reason } = data;
    
    console.log(`⏭️ User ${socket.user.name} skipped match in room ${roomId} (reason: ${reason || 'user_skipped'})`);
    
    // Notify other participant that partner skipped
    socket.to(roomId).emit('partnerSkipped', {
      userId: socket.userId,
      userName: socket.user.name,
      reason: reason || 'user_skipped'
    });
    
    // Leave room
    socket.leave(roomId);
    
    // Clean up room
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.participants = room.participants.filter(id => id !== socket.id);
      
      if (room.participants.length === 0) {
        rooms.delete(roomId);
        console.log(`🗑️ Room ${roomId} deleted (both users left)`);
      } else {
        console.log(`👤 Room ${roomId} now has ${room.participants.length} participant(s)`);
      }
    }
    
    // Delete active match
    if (activeMatches.has(matchId)) {
      activeMatches.delete(matchId);
      console.log(`🗑️ Match ${matchId} removed from active matches`);
    }
    
    // End match in database
    try {
      await query(
        `UPDATE matches SET ended_at = CURRENT_TIMESTAMP, status = 'ended' WHERE id = $1`,
        [matchId]
      );
      console.log(`✅ Match ${matchId} ended in database`);
    } catch (error) {
      console.error('Error ending match in database:', error);
    }
  });

  // Handle joining a video call room (FIXED - Prevent overcrowding)
  socket.on('joinVideoRoom', (data) => {
    const { roomId, matchId } = data;
    
    console.log(`🚪 Join request from ${socket.user.name} for room ${roomId}`);
    
    // Check if room exists and is full
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      
      // Room full check - MAX 2 participants
      if (room.participants.length >= 2 && !room.participants.includes(socket.id)) {
        console.log(`❌ Room ${roomId} is FULL (${room.participants.length} participants)`);
        socket.emit('roomFull', { 
          message: 'This video room is already full.',
          roomId 
        });
        return;
      }
      
      // Already in room check
      if (room.participants.includes(socket.id)) {
        console.log(`⚠️ User ${socket.user.name} already in room ${roomId}`);
        return;
      }
      
      // Add second participant
      room.participants.push(socket.id);
      socket.join(roomId);
      console.log(`📹 User ${socket.user.name} joined room ${roomId} (${room.participants.length}/2)`);
      
      // Emit roomReady ONLY when exactly 2 participants
      if (room.participants.length === 2) {
        io.to(roomId).emit('roomReady', {
          roomId,
          matchId,
          participants: 2
        });
        console.log(`✅ Room ${roomId} ready for WebRTC (2 participants)`);
      }
    } else {
      // Create new room
      rooms.set(roomId, {
        participants: [socket.id],
        matchId,
        createdAt: Date.now(),
        maxParticipants: 2
      });
      socket.join(roomId);
      console.log(`📹 User ${socket.user.name} created room ${roomId} (1/2)`);
    }
  });

  socket.on('leaveVideoRoom', async (data) => {
    const { roomId, matchId } = data;
    
    socket.leave(roomId);
    
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.participants = room.participants.filter(id => id !== socket.id);

      if (room.participants.length === 0) {
        rooms.delete(roomId);
        
        // End the match in database
        if (matchId) {
          try {
            await query('SELECT end_match($1, $2)', [matchId, socket.userId]);
            console.log(`🔚 Match ${matchId} ended`);
          } catch (error) {
            console.error('Error ending match:', error);
          }
        }
      } else {
        // Notify remaining participants
        socket.to(roomId).emit('participantLeft', {
          userId: socket.userId,
          roomId
        });
      }
    }
    
    console.log(`🚪 User ${socket.user.name} left video room ${roomId}`);
  });

  // Handle chat messages
  socket.on('sendMessage', async (data) => {
    try {
      const { matchId, content, messageType = 'text' } = data;
      
      // Save message to database
      const result = await query(
        'INSERT INTO messages (match_id, sender_id, content, message_type) VALUES ($1, $2, $3, $4) RETURNING *',
        [matchId, socket.userId, content, messageType]
      );
      
      const message = result.rows[0];
      const matchResult = await query('SELECT room_id FROM matches WHERE id = $1', [data.matchId]);
      
      if (matchResult.rows.length > 0) {
        io.to(matchResult.rows[0].room_id).emit('newMessage', {
          id: message.id,
          matchId: message.match_id,
          senderId: message.sender_id,
          senderName: socket.user.name,
          content: message.content,
          messageType: message.message_type,
          createdAt: message.created_at
        });
      }
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('messageError', {
        message: 'Failed to send message'
      });
    }
  });

  // Handle explicit online status updates
  socket.on('updateOnlineStatus', async (data) => {
    try {
      const { userId, isOnline } = data;
      
      // Only allow users to update their own status
      if (userId !== socket.userId) {
        console.warn(`User ${socket.userId} tried to update status for user ${userId}`);
        return;
      }
      
      // Update online status in database
      await query(
        'UPDATE users SET is_online = $1, last_seen = CURRENT_TIMESTAMP WHERE id = $2',
        [isOnline, socket.userId]
      );
      
      console.log(`🟢 Updated online status for user ${socket.user.name}: ${isOnline}`);
      
      // Broadcast status change to other users
      if (isOnline) {
        socket.broadcast.emit('userOnline', {
          userId: socket.userId,
          user: socket.user
        });
      } else {
        socket.broadcast.emit('userOffline', { userId: socket.userId });
      }
    } catch (error) {
      console.error('Error updating online status:', error);
    }
  });

  // Handle disconnect
  socket.on('disconnect', async () => {
    console.log(`🔴 User disconnected: ${socket.user.name} (${socket.userId})`);
    
    // Remove from active users
    activeUsers.delete(socket.userId);
    waitingUsers.delete(socket.userId);
    
    // Update user offline status in database
    try {
      await query(
        'UPDATE users SET is_online = false, last_seen = CURRENT_TIMESTAMP WHERE id = $1',
        [socket.userId]
      );
      
      // Update session status (if table exists)
      await query(
        'UPDATE user_sessions SET is_active = false WHERE user_id = $1',
        [socket.userId]
      ).catch(() => {
        // If user_sessions table doesn't exist, ignore this operation
        console.log('user_sessions table not found, skipping session update');
      });
    } catch (error) {
      console.error('Error updating user offline status:', error);
    }

    // Clean up any rooms the user was in
    for (const [roomId, room] of rooms.entries()) {
      if (room.participants.includes(socket.id)) {
        room.participants = room.participants.filter(id => id !== socket.id);
        
        // Notify other participants
        socket.to(roomId).emit('participantLeft', {
          userId: socket.userId,
          roomId
        });
        
        // If room is empty, clean up
        if (room.participants.length === 0) {
          rooms.delete(roomId);
        }
      }
    }

    // Emit user offline event
    socket.broadcast.emit('userOffline', {
      userId: socket.userId
    });
  });
});

// Function to find matches (Direct matching without gender filtering)
async function findMatch(userId) {
  try {
    const waitingUser = waitingUsers.get(userId);
    if (!waitingUser) return false;

    let matchedUserId = null;
    let matchedUserData = null;
    
    // Find first available user in queue
    for (const [otherUserId, otherUserData] of waitingUsers.entries()) {
      // Skip self and check if other user is still active and connected
      if (otherUserId !== userId && 
          activeUsers.has(otherUserId) && 
          otherUserData.socketId && 
          io.sockets.sockets.has(otherUserData.socketId)) {
        matchedUserId = otherUserId;
        matchedUserData = otherUserData;
        break;
      }
    }

    if (matchedUserId && matchedUserData) {
      console.log(`✅ Confirmed match: ${user.name} <-> ${matchedUserData.user.name}`);
      
      // Generate unique match and room IDs
      const matchId = `match-${userId}-${matchedUserId}-${Date.now()}`;
      const roomId = `room-${matchId}`;
      
      // Remove both users from waiting queue FIRST to prevent race conditions
      const user1Data = waitingUsers.get(userId);
      const user2Data = waitingUsers.get(matchedUserId);
      waitingUsers.delete(userId);
      waitingUsers.delete(matchedUserId);
      console.log(`🗑️ Removed both users from queue. Remaining: ${waitingUsers.size}`);
      
      // Store active match
      activeMatches.set(matchId, {
        user1Id: userId,
        user2Id: matchedUserId,
        roomId,
        startedAt: Date.now()
      });
      
      // Get socket connections
      const user1Socket = activeUsers.get(userId);
      const user2Socket = activeUsers.get(matchedUserId);
      
      // Validate socket connections more thoroughly
      const user1SocketExists = user1Socket && io.sockets.sockets.has(user1Socket.socketId);
      const user2SocketExists = user2Socket && io.sockets.sockets.has(user2Socket.socketId);
      
      console.log(`🔍 Socket validation - User1: ${user1SocketExists ? '✅' : '❌'}, User2: ${user2SocketExists ? '✅' : '❌'}`);
      
      if (user1SocketExists && user2SocketExists) {
        // Create match data for both users
        const matchDataForUser1 = {
          matchId,
          roomId,
          partner: {
            id: matchedUserId,
            name: matchedUserData.user.name,
            age: matchedUserData.user.age,
            country: matchedUserData.user.country,
            gender: matchedUserData.user.gender,
            avatar_url: matchedUserData.user.avatar_url
          },
          isInitiator: true
        };
        
        const matchDataForUser2 = {
          matchId,
          roomId,
          partner: {
            id: userId,
            name: waitingUser.user.name,
            age: waitingUser.user.age,
            country: waitingUser.user.country,
            gender: waitingUser.user.gender,
            avatar_url: waitingUser.user.avatar_url
          },
          isInitiator: false
        };
        
        console.log(`📤 Sending match notification to ${user.name} (${user1Socket.socketId})`);
        console.log(`📤 Sending match notification to ${matchedUserData.user.name} (${user2Socket.socketId})`);
        
        // Notify both users about the match
        io.to(user1Socket.socketId).emit('matchFound', matchDataForUser1);
        io.to(user2Socket.socketId).emit('matchFound', matchDataForUser2);
        
        console.log(`🎉 Match notifications sent: ${user.name} <-> ${matchedUserData.user.name} (Room: ${roomId})`);
        
        // Try to deduct tokens from both users
        try {
          await query('UPDATE users SET tokens = tokens - 1 WHERE id IN ($1, $2) AND tokens > 0', [userId, matchedUserId]);
          console.log(`💰 Tokens deducted for match ${matchId}`);
        } catch (error) {
          console.log('⚠️ Could not deduct tokens (continuing anyway):', error.message);
        }
        
        return true; // Match found and processed
      } else {
        console.log(`❌ Invalid socket connections - User1Socket: ${user1Socket?.socketId}, User2Socket: ${user2Socket?.socketId}`);
        console.log(`❌ Re-adding users to queue due to socket issues`);
        // Re-add users to queue if socket connection is lost
        if (user1Data) waitingUsers.set(userId, user1Data);
        if (user2Data) waitingUsers.set(matchedUserId, user2Data);
        return false;
      }
    } else {
      console.log(`⏳ No available match for ${user.name}. Staying in queue with ${waitingUsers.size} total users.`);
      
      // Send status update to user
      const userSocket = activeUsers.get(userId);
      if (userSocket) {
        io.to(userSocket.socketId).emit('matchingStatus', {
          status: 'searching',
          message: `Looking for match... ${waitingUsers.size} users in queue`,
          queueSize: waitingUsers.size
        });
      }
    }
    
    return false; // No match found
  } catch (error) {
    console.error('❌ Error finding match:', error);
    return false;
  }
}

// Process entire matching queue to find any possible matches
async function processMatchingQueue() {
  try {
    console.log(`🔄 Processing matching queue with ${waitingUsers.size} users`);
    
    if (waitingUsers.size < 2) {
      console.log('⚠️ Not enough users in queue for matching');
      return;
    }
    
    const userIds = Array.from(waitingUsers.keys());
    const processedUsers = new Set();
    let matchesFound = 0;
    
    // Try to match users in pairs
    for (let i = 0; i < userIds.length; i++) {
      const userId1 = userIds[i];
      
      // Skip if this user has already been matched or removed
      if (processedUsers.has(userId1) || !waitingUsers.has(userId1)) {
        continue;
      }
      
      for (let j = i + 1; j < userIds.length; j++) {
        const userId2 = userIds[j];
        
        // Skip if this user has already been matched or removed
        if (processedUsers.has(userId2) || !waitingUsers.has(userId2)) {
          continue;
        }
        
        // Check if both users are still active and connected
        const user1Data = waitingUsers.get(userId1);
        const user2Data = waitingUsers.get(userId2);
        
        if (user1Data && user2Data && 
            activeUsers.has(userId1) && activeUsers.has(userId2) &&
            io.sockets.sockets.has(user1Data.socketId) && 
            io.sockets.sockets.has(user2Data.socketId)) {
          
          console.log(`🎯 Processing queue match: ${user1Data.user.name} <-> ${user2Data.user.name}`);
          
          // Generate unique match and room IDs
          const matchId = `match-${userId1}-${userId2}-${Date.now()}`;
          const roomId = `room-${matchId}`;
          
          // Remove both users from waiting queue
          waitingUsers.delete(userId1);
          waitingUsers.delete(userId2);
          
          // Mark as processed
          processedUsers.add(userId1);
          processedUsers.add(userId2);
          
          // Store active match
          activeMatches.set(matchId, {
            user1Id: userId1,
            user2Id: userId2,
            roomId,
            startedAt: Date.now()
          });
          
          // Get socket connections
          const user1Socket = activeUsers.get(userId1);
          const user2Socket = activeUsers.get(userId2);
          
          if (user1Socket && user2Socket) {
            // Create match data
            const matchDataForUser1 = {
              matchId,
              roomId,
              partner: {
                id: userId2,
                name: user2Data.user.name,
                age: user2Data.user.age,
                country: user2Data.user.country,
                gender: user2Data.user.gender,
                avatar_url: user2Data.user.avatar_url
              },
              isInitiator: true
            };
            
            const matchDataForUser2 = {
              matchId,
              roomId,
              partner: {
                id: userId1,
                name: user1Data.user.name,
                age: user1Data.user.age,
                country: user1Data.user.country,
                gender: user1Data.user.gender,
                avatar_url: user1Data.user.avatar_url
              },
              isInitiator: false
            };
            
            // Notify both users about the match
            io.to(user1Socket.socketId).emit('matchFound', matchDataForUser1);
            io.to(user2Socket.socketId).emit('matchFound', matchDataForUser2);
            
            console.log(`🎉 Queue match created: ${user1Data.user.name} <-> ${user2Data.user.name}`);
            matchesFound++;
            
            // Try to deduct tokens from both users
            try {
              await query('UPDATE users SET tokens = tokens - 1 WHERE id IN ($1, $2) AND tokens > 0', [userId1, userId2]);
              console.log(`💰 Tokens deducted for queue match ${matchId}`);
            } catch (error) {
              console.log('⚠️ Could not deduct tokens for queue match:', error.message);
            }
            
            // Break inner loop since user1 is now matched
            break;
          }
        }
      }
    }
    
    console.log(`✅ Queue processing complete. ${matchesFound} matches created. ${waitingUsers.size} users remaining.`);
    
  } catch (error) {
    console.error('❌ Error processing matching queue:', error);
  }
}

// Periodic automatic matching for waiting users
setInterval(async () => {
  if (waitingUsers.size >= 2) {
    console.log(`🔄 Periodic matching check: ${waitingUsers.size} users waiting`);
    await processMatchingQueue();
  }
}, 5000); // Check every 5 seconds for matches

// Periodic cleanup of stale waiting users and rooms
setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of waitingUsers.entries()) {
    if (now - data.joinedAt > 300_000) {
      waitingUsers.delete(userId);
      const userSocket = activeUsers.get(userId);
      if (userSocket) {
        io.to(userSocket.socketId).emit('matchingTimeout', {
          message: 'No matches found. Please try again.'
        });
      }
    }
  }
  
  // Clean up empty rooms
  for (const [roomId, room] of rooms.entries()) {
    if (room.participants.length === 0) rooms.delete(roomId);
  }
}, 60000); // Run every minute

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error'
  });
});

app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✨ SwipX Backend server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📡 Socket.IO enabled with CORS:`, FRONTEND_URLS);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🚨 SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('🚨 SIGINT received, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
