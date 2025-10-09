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
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

app.use(cors({ origin: FRONTEND_URLS, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'SwipX Backend Running', 
    timestamp: new Date().toISOString(),
    stats: {
      activeUsers: activeUsers.size,
      waitingUsers: waitingUsers.size,
      activeRooms: rooms.size,
      activeMatches: activeMatches.size
    }
  });
});

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
  
  console.log(`🧹 RESET:`, stats);
  res.json({ success: true, cleared: stats });
});

app.use('/api/auth', authRoutes);
app.use('/api/matching', matchingRoutes);

io.use(socketAuth);

const activeUsers = new Map();
const waitingUsers = new Map();
const activeMatches = new Map();
const rooms = new Map();

io.on('connection', async (socket) => {
  console.log(`✅ ${socket.user.name} (${socket.userId})`);
  
  activeUsers.set(socket.userId, { socketId: socket.id, user: socket.user });

  try {
    await query('UPDATE users SET is_online = true, last_seen = CURRENT_TIMESTAMP WHERE id = $1', [socket.userId]);
  } catch (error) {
    console.error('Online err:', error);
  }

  socket.broadcast.emit('userOnline', { userId: socket.userId, user: socket.user });

  socket.on('joinMatchingQueue', async (preferences = {}) => {
    try {
      const user = socket.user;
      console.log(`🔍 ${user.name} joining queue with filters:`, preferences);

      if (user.is_premium) {
        if (user.tokens < 8) {
          console.log(`⚠️ ${user.name} insufficient tokens (${user.tokens})`);
          socket.emit('matchingError', { message: 'Insufficient tokens. Please recharge!' });
          return;
        }
      } else {
        if (preferences.gender || preferences.country) {
          socket.emit('matchingError', { 
            message: 'Gender and Country filters are Premium features! Upgrade to Premium to use filters.' 
          });
          return;
        }
      }

      waitingUsers.set(socket.userId, { 
        user, 
        preferences: {
          gender: preferences.gender || null,
          country: preferences.country || null,
          minAge: preferences.minAge || 18,
          maxAge: preferences.maxAge || 100
        },
        socketId: socket.id, 
        joinedAt: Date.now() 
      });

      console.log(`📊 Queue: ${waitingUsers.size} users`);

      socket.emit('matchingStatus', { 
        status: 'searching', 
        message: 'Searching for match...',
        queueSize: waitingUsers.size,
        filters: user.is_premium ? preferences : null
      });

      const matchFound = await findMatchWithFilters(socket.userId);
      
      if (!matchFound && waitingUsers.size >= 2) {
        await processMatchingQueue();
      }
      
    } catch (error) {
      console.error('Queue err:', error);
      socket.emit('matchingError', { message: 'Failed to join queue' });
    }
  });

  socket.on('leaveMatchingQueue', () => {
    waitingUsers.delete(socket.userId);
    console.log(`🚫 ${socket.user.name} left queue`);
    socket.emit('matchingStatus', { status: 'idle' });
  });

  // ============================================
  // 🔧 FIXED: joinVideoRoom with delay
  // ============================================
  socket.on('joinVideoRoom', (data) => {
    const { roomId, matchId } = data;
    console.log(`🚪 ${socket.user.name} → ${roomId} (socket: ${socket.id})`);
    
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      
      if (room.participants.includes(socket.id)) {
        console.log(`⚠️ ${socket.user.name} already in room`);
        return;
      }
      
      if (room.participants.length >= 2) {
        console.log(`❌ Room ${roomId} FULL (${room.participants.length}/2)`);
        socket.emit('roomFull', { roomId });
        return;
      }
      
      room.participants.push(socket.id);
      socket.join(roomId);
      console.log(`✅ ${socket.user.name} joined ${roomId} (${room.participants.length}/2)`);
      
      if (room.participants.length === 2) {
        console.log(`🎬 Room ${roomId} is READY with 2 participants`);
        console.log(`   Participants:`, room.participants);
        
        // ✅ CRITICAL FIX: Add 500ms delay + dual emission
        setTimeout(() => {
          console.log(`📤 Emitting roomReady to room: ${roomId}`);
          
          // Method 1: Emit to room
          io.to(roomId).emit('roomReady', { roomId, matchId, participants: 2 });
          
          // Method 2: Direct emit to each socket (backup)
          room.participants.forEach((participantSocketId, index) => {
            io.to(participantSocketId).emit('roomReady', { 
              roomId, 
              matchId, 
              participants: 2,
              isInitiator: index === 0 // First user is initiator
            });
            console.log(`   📤 Direct roomReady → socket ${participantSocketId}`);
          });
          
          console.log(`✅ roomReady emitted successfully`);
        }, 500); // 500ms delay to ensure frontend listeners attached
      }
    } else {
      rooms.set(roomId, { 
        participants: [socket.id], 
        matchId, 
        createdAt: Date.now(), 
        maxParticipants: 2 
      });
      socket.join(roomId);
      console.log(`📦 ${socket.user.name} CREATED room ${roomId} (1/2)`);
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
        console.log(`🗑️ Room ${roomId} deleted (empty)`);
      } else {
        socket.to(roomId).emit('participantLeft', { userId: socket.userId, roomId });
      }
    }
  });

  socket.on('webrtc-offer', (data) => {
    console.log(`📤 ${socket.user.name} sending offer to room ${data.roomId}`);
    socket.to(data.roomId).emit('webrtc-offer', { 
      offer: data.offer, 
      from: socket.userId, 
      fromName: socket.user.name 
    });
  });

  socket.on('webrtc-answer', (data) => {
    console.log(`📤 ${socket.user.name} sending answer to room ${data.roomId}`);
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

  socket.on('skipMatch', async (data) => {
    const { roomId, matchId } = data;
    console.log(`⏭️ ${socket.user.name} skip`);
    
    socket.to(roomId).emit('partnerSkipped', { 
      userId: socket.userId, 
      userName: socket.user.name 
    });
    
    socket.leave(roomId);
    
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.participants = room.participants.filter(id => id !== socket.id);
      if (room.participants.length === 0) {
        rooms.delete(roomId);
      }
    }
    
    if (activeMatches.has(matchId)) {
      activeMatches.delete(matchId);
    }
  });

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
      console.error('Msg err:', error);
      socket.emit('messageError', { message: 'Failed' });
    }
  });

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
      console.error('Status err:', error);
    }
  });

  socket.on('disconnect', async () => {
    console.log(`🔴 ${socket.user.name} disconnected`);
    
    activeUsers.delete(socket.userId);
    waitingUsers.delete(socket.userId);

    try {
      await query('UPDATE users SET is_online = false, last_seen = CURRENT_TIMESTAMP WHERE id = $1', 
        [socket.userId]);
    } catch (error) {
      console.error('Offline err:', error);
    }

    for (const [roomId, room] of rooms.entries()) {
      if (room.participants.includes(socket.id)) {
        room.participants = room.participants.filter(id => id !== socket.id);
        socket.to(roomId).emit('participantLeft', { userId: socket.userId, roomId });
        if (room.participants.length === 0) {
          rooms.delete(roomId);
        }
      }
    }

    socket.broadcast.emit('userOffline', { userId: socket.userId });
  });
});

async function findMatchWithFilters(userId) {
  try {
    const waitingUser = waitingUsers.get(userId);
    if (!waitingUser) return false;

    const userPrefs = waitingUser.preferences;
    let matchedUserId = null;
    let matchedUserData = null;
    
    for (const [otherUserId, otherUserData] of waitingUsers.entries()) {
      if (otherUserId === userId) continue;
      
      if (!activeUsers.has(otherUserId) || !io.sockets.sockets.has(otherUserData.socketId)) continue;

      const otherPrefs = otherUserData.preferences;
      const otherUser = otherUserData.user;

      let isMatch = true;

      if (userPrefs.gender && otherUser.gender !== userPrefs.gender) {
        isMatch = false;
      }
      if (userPrefs.country && otherUser.country !== userPrefs.country) {
        isMatch = false;
      }
      if (otherUser.age < userPrefs.minAge || otherUser.age > userPrefs.maxAge) {
        isMatch = false;
      }

      if (otherPrefs.gender && waitingUser.user.gender !== otherPrefs.gender) {
        isMatch = false;
      }
      if (otherPrefs.country && waitingUser.user.country !== otherPrefs.country) {
        isMatch = false;
      }
      if (waitingUser.user.age < otherPrefs.minAge || waitingUser.user.age > otherPrefs.maxAge) {
        isMatch = false;
      }

      if (isMatch) {
        matchedUserId = otherUserId;
        matchedUserData = otherUserData;
        break;
      }
    }

    if (matchedUserId && matchedUserData) {
      console.log(`🎯 MATCH: ${waitingUser.user.name} ↔ ${matchedUserData.user.name}`);

      const idsToDeduct = [];
      if (waitingUser.user.is_premium) idsToDeduct.push(userId);
      if (matchedUserData.user.is_premium) idsToDeduct.push(matchedUserId);

      if (idsToDeduct.length > 0) {
        try {
          await query('UPDATE users SET tokens = tokens - 8 WHERE id = ANY($1) AND is_premium = true AND tokens >= 8', 
            [idsToDeduct]);
          console.log(`💰 -8 tokens from ${idsToDeduct.length} users`);
        } catch (error) {
          console.error('Token err:', error);
        }
      }

      const matchId = `match-${userId}-${matchedUserId}-${Date.now()}`;
      const roomId = `room-${matchId}`;

      waitingUsers.delete(userId);
      waitingUsers.delete(matchedUserId);
      
      activeMatches.set(matchId, { 
        user1Id: userId, 
        user2Id: matchedUserId, 
        roomId, 
        startedAt: Date.now() 
      });

      const user1Socket = activeUsers.get(userId);
      const user2Socket = activeUsers.get(matchedUserId);

      if (user1Socket && user2Socket) {
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

        return true;
      }
    }
    
    return false;
  } catch (error) {
    console.error('Match err:', error);
    return false;
  }
}

async function processMatchingQueue() {
  if (waitingUsers.size < 2) return;
  console.log(`🔄 Queue: ${waitingUsers.size}`);

  const userIds = Array.from(waitingUsers.keys());

  for (const userId of userIds) {
    if (!waitingUsers.has(userId)) continue;
    await findMatchWithFilters(userId);
  }
}

setInterval(async () => {
  if (waitingUsers.size >= 2) {
    await processMatchingQueue();
  }
}, 5000);

setInterval(() => {
  const now = Date.now();
  
  for (const [userId, data] of waitingUsers.entries()) {
    if (now - data.joinedAt > 300_000) {
      waitingUsers.delete(userId);
      const userSocket = activeUsers.get(userId);
      if (userSocket) {
        io.to(userSocket.socketId).emit('matchingTimeout', { message: 'Timeout' });
      }
    }
  }
  
  for (const [roomId, room] of rooms.entries()) {
    if (room.participants.length === 0) {
      rooms.delete(roomId);
    }
  }
}, 60_000);

setInterval(async () => {
  try {
    await query('UPDATE users SET is_premium = false WHERE premium_expiry_date < CURRENT_TIMESTAMP AND is_premium = true');
  } catch (error) {
    console.error('Premium expiry err:', error);
  }
}, 3600_000);

app.use((err, req, res, next) => {
  console.error('Err:', err);
  res.status(500).json({ success: false, message: 'Error' });
});

app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✨ SwipX Backend: ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
