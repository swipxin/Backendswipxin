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
  message: { success: false, message: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

app.use(cors({ origin: FRONTEND_URLS, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'SwipX Backend running', 
    timestamp: new Date().toISOString(),
    stats: {
      activeUsers: activeUsers.size,
      waitingUsers: waitingUsers.size,
      activeRooms: rooms.size,
      activeMatches: activeMatches.size
    }
  });
});

// Emergency reset
app.get('/api/emergency-reset', (req, res) => {
  const stats = { 
    rooms: rooms.size, 
    matches: activeMatches.size, 
    waiting: waitingUsers.size,
    active: activeUsers.size
  };
  
  rooms.clear();
  activeMatches.clear();
  waitingUsers.clear();
  
  console.log(`🧹 EMERGENCY RESET:`, stats);
  res.json({ success: true, cleared: stats });
});

app.use('/api/auth', authRoutes);
app.use('/api/matching', matchingRoutes);

io.use(socketAuth);

// ============================================
// 🎯 GLOBAL STATE MANAGEMENT (Multi-User)
// ============================================

const activeUsers = new Map();      // userId -> { socketId, user }
const waitingUsers = new Map();     // userId -> { user, preferences, socketId, joinedAt }
const activeMatches = new Map();    // matchId -> { user1Id, user2Id, roomId, startedAt }
const rooms = new Map();            // roomId -> { participants[], matchId, createdAt, maxParticipants }

// ============================================
// 🔌 SOCKET.IO CONNECTION HANDLER
// ============================================

io.on('connection', async (socket) => {
  console.log(`✅ ${socket.user.name} connected (${socket.userId})`);
  
  // Register active user
  activeUsers.set(socket.userId, { 
    socketId: socket.id, 
    user: socket.user 
  });

  // Update online status in DB
  try {
    await query('UPDATE users SET is_online = true, last_seen = CURRENT_TIMESTAMP WHERE id = $1', [socket.userId]);
  } catch (error) {
    console.error('Online status update error:', error);
  }

  // Broadcast user online
  socket.broadcast.emit('userOnline', { 
    userId: socket.userId, 
    user: socket.user 
  });

  // ============================================
  // 📋 MATCHING QUEUE HANDLER
  // ============================================
  
  socket.on('joinMatchingQueue', async (preferences = {}) => {
    try {
      const user = socket.user;

      console.log(`🔍 ${user.name} joining queue`);

      // ✅ Premium token check
      if (user.is_premium) {
        if (user.tokens < 8) {
          console.log(`⚠️ ${user.name} insufficient tokens (${user.tokens})`);
          socket.emit('matchingError', { 
            message: 'Insufficient tokens. Please recharge.' 
          });
          return;
        }
      }

      // Add to waiting queue
      waitingUsers.set(socket.userId, { 
        user, 
        preferences, 
        socketId: socket.id, 
        joinedAt: Date.now() 
      });

      console.log(`📊 Queue size: ${waitingUsers.size}`);

      socket.emit('matchingStatus', { 
        status: 'searching', 
        message: 'Searching for match...',
        queueSize: waitingUsers.size
      });

      // Try to find match immediately
      const matchFound = await findMatch(socket.userId);
      
      if (!matchFound && waitingUsers.size >= 2) {
        // Process queue if no immediate match
        await processMatchingQueue();
      }
      
    } catch (error) {
      console.error('Queue join error:', error);
      socket.emit('matchingError', { message: 'Failed to join queue' });
    }
  });

  socket.on('leaveMatchingQueue', () => {
    waitingUsers.delete(socket.userId);
    console.log(`🚫 ${socket.user.name} left queue`);
    socket.emit('matchingStatus', { status: 'idle', message: 'Stopped' });
  });

  // ============================================
  // 🎥 VIDEO ROOM HANDLERS
  // ============================================

  socket.on('joinVideoRoom', (data) => {
    const { roomId, matchId } = data;
    
    console.log(`🚪 ${socket.user.name} → ${roomId}`);
    
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      
      // Already in room?
      if (room.participants.includes(socket.id)) {
        console.log(`⚠️ Already in room`);
        return;
      }
      
      // Room full?
      if (room.participants.length >= 2) {
        console.log(`❌ Room FULL (${room.participants.length}/2)`);
        socket.emit('roomFull', { message: 'Room full', roomId });
        return;
      }
      
      // Add participant
      room.participants.push(socket.id);
      socket.join(roomId);
      
      console.log(`✅ Joined ${roomId} (${room.participants.length}/2)`);
      
      // Emit roomReady when 2 participants
      if (room.participants.length === 2) {
        console.log(`🎬 ROOM READY: ${roomId}`);
        io.to(roomId).emit('roomReady', { 
          roomId, 
          matchId, 
          participants: 2 
        });
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
      
      console.log(`📦 CREATED room ${roomId} (1/2)`);
    }
  });

  socket.on('leaveVideoRoom', async (data) => {
    const { roomId } = data;
    
    socket.leave(roomId);
    console.log(`🚪 ${socket.user.name} left ${roomId}`);

    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.participants = room.participants.filter(id => id !== socket.id);

      if (room.participants.length === 0) {
        rooms.delete(roomId);
        console.log(`🗑️ Room ${roomId} deleted`);
      } else {
        socket.to(roomId).emit('participantLeft', { 
          userId: socket.userId, 
          roomId 
        });
      }
    }
  });

  // ============================================
  // 🔄 WebRTC SIGNALING
  // ============================================

  socket.on('webrtc-offer', (data) => {
    socket.to(data.roomId).emit('webrtc-offer', { 
      offer: data.offer, 
      from: socket.userId, 
      fromName: socket.user.name 
    });
  });

  socket.on('webrtc-answer', (data) => {
    socket.to(data.roomId).emit('webrtc-answer', { 
      answer: data.answer, 
      from: socket.userId, 
      fromName: socket.user.name 
    });
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.roomId).emit('ice-candidate', { 
      candidate: data.candidate, 
      from: socket.userId, 
      fromName: socket.user.name 
    });
  });

  // ============================================
  // ⏭️ SKIP MATCH
  // ============================================

  socket.on('skipMatch', async (data) => {
    const { roomId, matchId } = data;
    
    console.log(`⏭️ ${socket.user.name} skipped`);
    
    // Notify partner
    socket.to(roomId).emit('partnerSkipped', { 
      userId: socket.userId, 
      userName: socket.user.name 
    });
    
    // Leave room
    socket.leave(roomId);
    
    // Cleanup room
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.participants = room.participants.filter(id => id !== socket.id);
      
      if (room.participants.length === 0) {
        rooms.delete(roomId);
        console.log(`🗑️ Room ${roomId} deleted`);
      }
    }
    
    // Cleanup match
    if (activeMatches.has(matchId)) {
      activeMatches.delete(matchId);
      console.log(`🗑️ Match ${matchId} deleted`);
    }
  });

  // ============================================
  // 💬 CHAT MESSAGES
  // ============================================

  socket.on('sendMessage', async (data) => {
    try {
      const result = await query(
        'INSERT INTO messages (match_id, sender_id, content, message_type) VALUES ($1, $2, $3, $4) RETURNING *', 
        [data.matchId, socket.userId, data.content, data.messageType || 'text']
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
      console.error('Message error:', error);
      socket.emit('messageError', { message: 'Failed to send' });
    }
  });

  // ============================================
  // 👤 ONLINE STATUS
  // ============================================

  socket.on('updateOnlineStatus', async (data) => {
    if (data.userId !== socket.userId) return;
    
    try {
      await query('UPDATE users SET is_online = $1, last_seen = CURRENT_TIMESTAMP WHERE id = $2', 
        [data.isOnline, socket.userId]);
      
      if (data.isOnline) {
        socket.broadcast.emit('userOnline', { userId: socket.userId, user: socket.user });
      } else {
        socket.broadcast.emit('userOffline', { userId: socket.userId });
      }
    } catch (error) {
      console.error('Status update error:', error);
    }
  });

  // ============================================
  // 🔌 DISCONNECT HANDLER
  // ============================================

  socket.on('disconnect', async () => {
    console.log(`🔴 ${socket.user.name} disconnected`);
    
    // Remove from active users
    activeUsers.delete(socket.userId);
    waitingUsers.delete(socket.userId);

    // Update DB
    try {
      await query('UPDATE users SET is_online = false, last_seen = CURRENT_TIMESTAMP WHERE id = $1', 
        [socket.userId]);
    } catch (error) {
      console.error('Offline update error:', error);
    }

    // Cleanup rooms
    for (const [roomId, room] of rooms.entries()) {
      if (room.participants.includes(socket.id)) {
        room.participants = room.participants.filter(id => id !== socket.id);
        socket.to(roomId).emit('participantLeft', { userId: socket.userId, roomId });
        
        if (room.participants.length === 0) {
          rooms.delete(roomId);
        }
      }
    }

    // Broadcast offline
    socket.broadcast.emit('userOffline', { userId: socket.userId });
  });
});

// ============================================
// 🎯 MATCHING ALGORITHM (Multi-User Support)
// ============================================

async function findMatch(userId) {
  try {
    const waitingUser = waitingUsers.get(userId);
    if (!waitingUser) return false;

    let matchedUserId = null;
    let matchedUserData = null;
    
    // Find first available user in queue
    for (const [otherUserId, otherUserData] of waitingUsers.entries()) {
      if (otherUserId !== userId && 
          activeUsers.has(otherUserId) && 
          io.sockets.sockets.has(otherUserData.socketId)) {
        
        matchedUserId = otherUserId;
        matchedUserData = otherUserData;
        break;
      }
    }

    if (matchedUserId && matchedUserData) {
      console.log(`🎯 MATCH: ${waitingUser.user.name} ↔ ${matchedUserData.user.name}`);

      // Deduct tokens for premium users
      const idsToDeduct = [];
      if (waitingUser.user.is_premium) idsToDeduct.push(userId);
      if (matchedUserData.user.is_premium) idsToDeduct.push(matchedUserId);

      if (idsToDeduct.length > 0) {
        try {
          await query('UPDATE users SET tokens = tokens - 8 WHERE id = ANY($1) AND is_premium = true AND tokens >= 8', 
            [idsToDeduct]);
          console.log(`💰 Deducted 8 tokens from: ${idsToDeduct.join(', ')}`);
        } catch (error) {
          console.error('Token deduction error:', error);
        }
      }

      const matchId = `match-${userId}-${matchedUserId}-${Date.now()}`;
      const roomId = `room-${matchId}`;

      // Remove from queue
      waitingUsers.delete(userId);
      waitingUsers.delete(matchedUserId);
      
      // Add to active matches
      activeMatches.set(matchId, { 
        user1Id: userId, 
        user2Id: matchedUserId, 
        roomId, 
        startedAt: Date.now() 
      });

      const user1Socket = activeUsers.get(userId);
      const user2Socket = activeUsers.get(matchedUserId);

      if (user1Socket && user2Socket) {
        // Emit match to User 1
        io.to(user1Socket.socketId).emit('matchFound', {
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
        });
        
        // Emit match to User 2
        io.to(user2Socket.socketId).emit('matchFound', {
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
        });

        console.log(`✅ Match emitted: ${matchId}`);
        return true;
      }
    }
    
    return false;
  } catch (error) {
    console.error('Find match error:', error);
    return false;
  }
}

// ============================================
// 🔄 BATCH MATCHING PROCESSOR
// ============================================

async function processMatchingQueue() {
  if (waitingUsers.size < 2) return;

  console.log(`🔄 Processing queue (${waitingUsers.size} users)`);

  const userIds = Array.from(waitingUsers.keys());
  const processedUsers = new Set();

  for (let i = 0; i < userIds.length; i++) {
    const userId1 = userIds[i];
    if (processedUsers.has(userId1) || !waitingUsers.has(userId1)) continue;

    for (let j = i + 1; j < userIds.length; j++) {
      const userId2 = userIds[j];
      if (processedUsers.has(userId2) || !waitingUsers.has(userId2)) continue;

      const user1Data = waitingUsers.get(userId1);
      const user2Data = waitingUsers.get(userId2);

      if (user1Data && user2Data && activeUsers.has(userId1) && activeUsers.has(userId2)) {
        const matchId = `match-${userId1}-${userId2}-${Date.now()}`;
        const roomId = `room-${matchId}`;

        // Remove from queue
        waitingUsers.delete(userId1);
        waitingUsers.delete(userId2);
        processedUsers.add(userId1);
        processedUsers.add(userId2);
        
        // Add to matches
        activeMatches.set(matchId, { 
          user1Id: userId1, 
          user2Id: userId2, 
          roomId, 
          startedAt: Date.now() 
        });

        const user1Socket = activeUsers.get(userId1);
        const user2Socket = activeUsers.get(userId2);

        if (user1Socket && user2Socket) {
          io.to(user1Socket.socketId).emit('matchFound', {
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
          });
          
          io.to(user2Socket.socketId).emit('matchFound', {
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
          });

          // Deduct tokens
          try {
            await query('UPDATE users SET tokens = tokens - 8 WHERE id = ANY($1) AND is_premium = true AND tokens >= 8', 
              [[userId1, userId2]]);
          } catch (error) {
            console.error('Token deduction error:', error);
          }
          
          console.log(`✅ Batch matched: ${user1Data.user.name} ↔ ${user2Data.user.name}`);
          break;
        }
      }
    }
  }
}

// ============================================
// ⏰ BACKGROUND JOBS
// ============================================

// Process queue every 5 seconds
setInterval(async () => {
  if (waitingUsers.size >= 2) {
    await processMatchingQueue();
  }
}, 5000);

// Cleanup stale waiting users (5 min timeout)
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
      console.log(`⏰ Timeout: ${data.user.name}`);
    }
  }
  
  // Cleanup empty rooms
  for (const [roomId, room] of rooms.entries()) {
    if (room.participants.length === 0) {
      rooms.delete(roomId);
    }
  }
}, 60_000);

// ============================================
// 🚀 ERROR HANDLERS & SERVER START
// ============================================

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ success: false, message: 'Internal error' });
});

app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✨ SwipX Backend running on ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM - shutting down');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('SIGINT - shutting down');
  server.close(() => process.exit(0));
});
