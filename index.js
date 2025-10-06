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
  }
});

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, message: 'Too many requests from this IP, please try again later.' },
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
    message: 'SwipX Backend is running!', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeRooms: rooms.size,
    waitingUsers: waitingUsers.size
  });
});

app.get('/api/emergency-reset', (req, res) => {
  const roomCount = rooms.size;
  const matchCount = activeMatches.size;
  const waitingCount = waitingUsers.size;
  rooms.clear();
  activeMatches.clear();
  waitingUsers.clear();
  console.log(`🧹 EMERGENCY RESET: Cleared ${roomCount} rooms, ${matchCount} matches, ${waitingCount} waiting users`);
  res.json({ 
    success: true, 
    cleared: { rooms: roomCount, matches: matchCount, waiting: waitingCount },
    message: 'All rooms, matches, and waiting queue cleared'
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/matching', matchingRoutes);

io.use(socketAuth);

const activeUsers = new Map();
const waitingUsers = new Map();
const activeMatches = new Map();
const rooms = new Map();

io.on('connection', async (socket) => {
  console.log(`✅ User connected: ${socket.user.name} (${socket.userId})`);
  
  activeUsers.set(socket.userId, { socketId: socket.id, user: socket.user });

  try {
    await query('UPDATE users SET is_online = true, last_seen = CURRENT_TIMESTAMP WHERE id = $1', [socket.userId]);
  } catch (error) {
    console.error('Error updating user online status:', error);
  }

  socket.broadcast.emit('userOnline', { userId: socket.userId, user: socket.user });

  socket.on('joinMatchingQueue', async (preferences = {}) => {
    try {
      console.log(`🔍 User ${socket.user.name} joined matching queue`);
      
      if (socket.user.tokens < 1) {
        socket.emit('matchingError', { message: 'Insufficient tokens. You need at least 1 token to start a video call.' });
        return;
      }

      waitingUsers.set(socket.userId, {
        user: socket.user,
        preferences,
        socketId: socket.id,
        joinedAt: Date.now()
      });

      console.log(`📊 Queue size: ${waitingUsers.size}`);
      socket.emit('matchingStatus', { status: 'searching', message: 'Looking for a match...' });

      const matchFound = await findMatch(socket.userId);
      if (!matchFound && waitingUsers.size >= 2) {
        await processMatchingQueue();
      }
    } catch (error) {
      console.error('Error joining matching queue:', error);
      socket.emit('matchingError', { message: 'Failed to join matching queue' });
    }
  });

  socket.on('leaveMatchingQueue', () => {
    waitingUsers.delete(socket.userId);
    socket.emit('matchingStatus', { status: 'idle', message: 'Stopped searching for matches' });
    console.log(`🚨 User ${socket.user.name} left matching queue`);
  });

  socket.on('webrtc-offer', (data) => {
    const { roomId, offer } = data;
    console.log(`📤 [WebRTC] Offer from ${socket.user.name} to room ${roomId}`);
    socket.to(roomId).emit('webrtc-offer', { offer: offer, from: socket.userId, fromName: socket.user.name });
  });

  socket.on('webrtc-answer', (data) => {
    const { roomId, answer } = data;
    console.log(`📤 [WebRTC] Answer from ${socket.user.name} to room ${roomId}`);
    socket.to(roomId).emit('webrtc-answer', { answer: answer, from: socket.userId, fromName: socket.user.name });
  });

  socket.on('ice-candidate', (data) => {
    const { roomId, candidate } = data;
    console.log(`🧊 [WebRTC] ICE candidate from ${socket.user.name}`);
    socket.to(roomId).emit('ice-candidate', { candidate: candidate, from: socket.userId, fromName: socket.user.name });
  });

  socket.on('skipMatch', async (data) => {
    const { roomId, matchId, reason } = data;
    console.log(`⏭️ User ${socket.user.name} skipped match in room ${roomId}`);
    socket.to(roomId).emit('partnerSkipped', { userId: socket.userId, userName: socket.user.name, reason: reason || 'user_skipped' });
    socket.leave(roomId);
    
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.participants = room.participants.filter(id => id !== socket.id);
      if (room.participants.length === 0) {
        rooms.delete(roomId);
        console.log(`🗑️ Room ${roomId} deleted`);
      }
    }
    
    if (activeMatches.has(matchId)) {
      activeMatches.delete(matchId);
    }
  });

  socket.on('joinVideoRoom', (data) => {
    const { roomId, matchId } = data;
    console.log(`🚪 ${socket.user.name} requesting to join room ${roomId}`);
    
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      
      if (room.participants.length >= 2 && !room.participants.includes(socket.id)) {
        console.log(`❌ ROOM FULL: ${roomId} already has ${room.participants.length} participants`);
        socket.emit('roomFull', { message: 'This video room is full.', roomId });
        return;
      }
      
      if (room.participants.includes(socket.id)) {
        console.log(`⚠️ ${socket.user.name} already in room ${roomId}`);
        return;
      }
      
      room.participants.push(socket.id);
      socket.join(roomId);
      console.log(`📹 ${socket.user.name} joined room ${roomId} (${room.participants.length}/2)`);
      
      if (room.participants.length === 2) {
        io.to(roomId).emit('roomReady', { roomId, matchId, participants: 2 });
        console.log(`✅ Room ${roomId} ready with 2 participants`);
      }
    } else {
      rooms.set(roomId, { participants: [socket.id], matchId, createdAt: Date.now(), maxParticipants: 2 });
      socket.join(roomId);
      console.log(`📹 ${socket.user.name} created room ${roomId} (1/2)`);
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
      } else {
        socket.to(roomId).emit('participantLeft', { userId: socket.userId, roomId });
      }
    }
    console.log(`🚪 ${socket.user.name} left room ${roomId}`);
  });

  socket.on('sendMessage', async (data) => {
    try {
      const { matchId, content, messageType = 'text' } = data;
      const result = await query('INSERT INTO messages (match_id, sender_id, content, message_type) VALUES ($1, $2, $3, $4) RETURNING *', [matchId, socket.userId, content, messageType]);
      const message = result.rows[0];
      const matchResult = await query('SELECT room_id FROM matches WHERE id = $1', [matchId]);
      
      if (matchResult.rows.length > 0) {
        const roomId = matchResult.rows[0].room_id;
        io.to(roomId).emit('newMessage', {
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
      socket.emit('messageError', { message: 'Failed to send message' });
    }
  });

  socket.on('updateOnlineStatus', async (data) => {
    try {
      const { userId, isOnline } = data;
      if (userId !== socket.userId) return;
      
      await query('UPDATE users SET is_online = $1, last_seen = CURRENT_TIMESTAMP WHERE id = $2', [isOnline, socket.userId]);
      
      if (isOnline) {
        socket.broadcast.emit('userOnline', { userId: socket.userId, user: socket.user });
      } else {
        socket.broadcast.emit('userOffline', { userId: socket.userId });
      }
    } catch (error) {
      console.error('Error updating online status:', error);
    }
  });

  socket.on('disconnect', async () => {
    console.log(`🔴 ${socket.user.name} disconnected`);
    activeUsers.delete(socket.userId);
    waitingUsers.delete(socket.userId);
    
    try {
      await query('UPDATE users SET is_online = false, last_seen = CURRENT_TIMESTAMP WHERE id = $1', [socket.userId]);
    } catch (error) {
      console.error('Error updating user offline status:', error);
    }

    for (const [roomId, room] of rooms.entries()) {
      if (room.participants.includes(socket.id)) {
        room.participants = room.participants.filter(id => id !== socket.id);
        socket.to(roomId).emit('participantLeft', { userId: socket.userId, roomId });
        if (room.participants.length === 0) rooms.delete(roomId);
      }
    }

    socket.broadcast.emit('userOffline', { userId: socket.userId });
  });
});

async function findMatch(userId) {
  try {
    const waitingUser = waitingUsers.get(userId);
    if (!waitingUser) return false;

    const { user } = waitingUser;
    let matchedUserId = null;
    let matchedUserData = null;
    
    for (const [otherUserId, otherUserData] of waitingUsers.entries()) {
      if (otherUserId !== userId && activeUsers.has(otherUserId) && otherUserData.socketId && io.sockets.sockets.has(otherUserData.socketId)) {
        matchedUserId = otherUserId;
        matchedUserData = otherUserData;
        break;
      }
    }

    if (matchedUserId && matchedUserData) {
      console.log(`✅ Match: ${user.name} <-> ${matchedUserData.user.name}`);
      
      const matchId = `match-${userId}-${matchedUserId}-${Date.now()}`;
      const roomId = `room-${matchId}`;
      
      waitingUsers.delete(userId);
      waitingUsers.delete(matchedUserId);
      activeMatches.set(matchId, { user1Id: userId, user2Id: matchedUserId, roomId, startedAt: Date.now() });
      
      const user1Socket = activeUsers.get(userId);
      const user2Socket = activeUsers.get(matchedUserId);
      
      if (user1Socket && user2Socket) {
        const matchDataForUser1 = {
          matchId, roomId,
          partner: { id: matchedUserId, name: matchedUserData.user.name, age: matchedUserData.user.age, country: matchedUserData.user.country, gender: matchedUserData.user.gender, avatar_url: matchedUserData.user.avatar_url },
          isInitiator: true
        };
        
        const matchDataForUser2 = {
          matchId, roomId,
          partner: { id: userId, name: user.name, age: user.age, country: user.country, gender: user.gender, avatar_url: user.avatar_url },
          isInitiator: false
        };
        
        io.to(user1Socket.socketId).emit('matchFound', matchDataForUser1);
        io.to(user2Socket.socketId).emit('matchFound', matchDataForUser2);
        
        console.log(`🎉 Match created: ${user.name} <-> ${matchedUserData.user.name}`);
        
        try {
          await query('UPDATE users SET tokens = tokens - 1 WHERE id IN ($1, $2) AND tokens > 0', [userId, matchedUserId]);
        } catch (error) {
          console.log('⚠️ Could not deduct tokens:', error.message);
        }
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error('❌ Error finding match:', error);
    return false;
  }
}

async function processMatchingQueue() {
  try {
    if (waitingUsers.size < 2) return;
    
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
          
          waitingUsers.delete(userId1);
          waitingUsers.delete(userId2);
          processedUsers.add(userId1);
          processedUsers.add(userId2);
          activeMatches.set(matchId, { user1Id: userId1, user2Id: userId2, roomId, startedAt: Date.now() });
          
          const user1Socket = activeUsers.get(userId1);
          const user2Socket = activeUsers.get(userId2);
          
          if (user1Socket && user2Socket) {
            const matchDataForUser1 = {
              matchId, roomId,
              partner: { id: userId2, name: user2Data.user.name, age: user2Data.user.age, country: user2Data.user.country, gender: user2Data.user.gender, avatar_url: user2Data.user.avatar_url },
              isInitiator: true
            };
            
            const matchDataForUser2 = {
              matchId, roomId,
              partner: { id: userId1, name: user1Data.user.name, age: user1Data.user.age, country: user1Data.user.country, gender: user1Data.user.gender, avatar_url: user1Data.user.avatar_url },
              isInitiator: false
            };
            
            io.to(user1Socket.socketId).emit('matchFound', matchDataForUser1);
            io.to(user2Socket.socketId).emit('matchFound', matchDataForUser2);
            
            try {
              await query('UPDATE users SET tokens = tokens - 1 WHERE id IN ($1, $2) AND tokens > 0', [userId1, userId2]);
            } catch (error) {
              console.log('⚠️ Could not deduct tokens:', error.message);
            }
            break;
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Error processing matching queue:', error);
  }
}

setInterval(async () => {
  if (waitingUsers.size >= 2) await processMatchingQueue();
}, 5000);

setInterval(() => {
  const now = Date.now();
  const maxWaitTime = 5 * 60 * 1000;
  
  for (const [userId, data] of waitingUsers.entries()) {
    if (now - data.joinedAt > maxWaitTime) {
      waitingUsers.delete(userId);
      const userSocket = activeUsers.get(userId);
      if (userSocket) io.to(userSocket.socketId).emit('matchingTimeout', { message: 'No matches found. Please try again.' });
    }
  }
  
  for (const [roomId, room] of rooms.entries()) {
    if (room.participants.length === 0) rooms.delete(roomId);
  }
}, 60000);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✨ SwipX Backend running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
});

process.on('SIGTERM', () => {
  console.log('🚨 SIGTERM received, shutting down...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🚨 SIGINT received, shutting down...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
