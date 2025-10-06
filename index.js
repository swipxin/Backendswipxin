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
    uptime: Math.floor(process.uptime()),
    activeRooms: rooms.size,
    waitingUsers: waitingUsers.size
  });
});

app.get('/api/emergency-reset', (req, res) => {
  const clearedStats = { rooms: rooms.size, matches: activeMatches.size, waiting: waitingUsers.size };
  rooms.clear();
  activeMatches.clear();
  waitingUsers.clear();
  console.log(`🧹 EMERGENCY RESET: Cleared rooms, matches, waiting`);
  res.json({ success: true, cleared: clearedStats, message: 'All rooms, matches, and waiting cleared' });
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
    console.error('Error updating online status:', error);
  }

  socket.broadcast.emit('userOnline', { userId: socket.userId, user: socket.user });

  socket.on('joinMatchingQueue', async (preferences = {}) => {
    try {
      const user = socket.user;

      // Premium check
      if (user.is_premium) {
        if (user.tokens < 8) {
          socket.emit('matchingError', { message: 'Insufficient tokens. Please buy premium to continue matching.' });
          return;
        }
      }

      waitingUsers.set(socket.userId, { user: user, preferences, socketId: socket.id, joinedAt: Date.now() });
      socket.emit('matchingStatus', { status: 'searching', message: 'Looking for match...' });

      const matchFound = await findMatch(socket.userId);
      if (!matchFound && waitingUsers.size >= 2) await processMatchingQueue();
    } catch (error) {
      console.error('Error joining matching queue:', error);
      socket.emit('matchingError', { message: 'Failed to join matching queue' });
    }
  });

  socket.on('leaveMatchingQueue', () => {
    waitingUsers.delete(socket.userId);
    socket.emit('matchingStatus', { status: 'idle', message: 'Stopped searching' });
  });

  socket.on('webrtc-offer', (data) => {
    socket.to(data.roomId).emit('webrtc-offer', { offer: data.offer, from: socket.userId, fromName: socket.user.name });
  });

  socket.on('webrtc-answer', (data) => {
    socket.to(data.roomId).emit('webrtc-answer', { answer: data.answer, from: socket.userId, fromName: socket.user.name });
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.roomId).emit('ice-candidate', { candidate: data.candidate, from: socket.userId, fromName: socket.user.name });
  });

  socket.on('skipMatch', async (data) => {
    socket.to(data.roomId).emit('partnerSkipped', { userId: socket.userId, userName: socket.user.name });
    socket.leave(data.roomId);

    if (rooms.has(data.roomId)) {
      const room = rooms.get(data.roomId);
      room.participants = room.participants.filter(id => id !== socket.id);
      if (room.participants.length === 0) rooms.delete(data.roomId);
    }
    if (activeMatches.has(data.matchId)) activeMatches.delete(data.matchId);
  });

  socket.on('joinVideoRoom', (data) => {
    const { roomId, matchId } = data;

    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);

      if (room.participants.length >= 2 && !room.participants.includes(socket.id)) {
        socket.emit('roomFull', { message: 'Room full', roomId });
        return;
      }

      if (!room.participants.includes(socket.id)) {
        room.participants.push(socket.id);
        socket.join(roomId);
        if (room.participants.length === 2) {
          io.to(roomId).emit('roomReady', { roomId, matchId, participants: 2 });
        }
      }
    } else {
      rooms.set(roomId, { participants: [socket.id], matchId, createdAt: Date.now(), maxParticipants: 2 });
      socket.join(roomId);
    }
  });

  socket.on('leaveVideoRoom', async (data) => {
    socket.leave(data.roomId);

    if (rooms.has(data.roomId)) {
      const room = rooms.get(data.roomId);
      room.participants = room.participants.filter(id => id !== socket.id);

      if (room.participants.length === 0) {
        rooms.delete(data.roomId);
      } else {
        socket.to(data.roomId).emit('participantLeft', { userId: socket.userId, roomId: data.roomId });
      }
    }
  });

  socket.on('sendMessage', async (data) => {
    try {
      const result = await query('INSERT INTO messages (match_id, sender_id, content, message_type) VALUES ($1, $2, $3, $4) RETURNING *', 
        [data.matchId, socket.userId, data.content, data.messageType || 'text']);
        
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
      console.error('Message sending error:', error);
      socket.emit('messageError', { message: 'Failed to send message' });
    }
  });

  socket.on('updateOnlineStatus', async (data) => {
    if (data.userId !== socket.userId) return;
    try {
      await query('UPDATE users SET is_online = $1, last_seen = CURRENT_TIMESTAMP WHERE id = $2', [data.isOnline, socket.userId]);
      if (data.isOnline) {
        socket.broadcast.emit('userOnline', { userId: socket.userId, user: socket.user });
      } else {
        socket.broadcast.emit('userOffline', { userId: socket.userId });
      }
    } catch (error) {
      console.error('Online status update error:', error);
    }
  });

  socket.on('disconnect', async () => {
    activeUsers.delete(socket.userId);
    waitingUsers.delete(socket.userId);

    try {
      await query('UPDATE users SET is_online = false, last_seen = CURRENT_TIMESTAMP WHERE id = $1', [socket.userId]);
    } catch (error) {
      console.error('Failed to update offline status:', error);
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

    let matchedUserId = null;
    let matchedUserData = null;
    
    for (const [otherUserId, otherUserData] of waitingUsers.entries()) {
      if (otherUserId !== userId && activeUsers.has(otherUserId) && io.sockets.sockets.has(otherUserData.socketId)) {
        
        matchedUserId = otherUserId;
        matchedUserData = otherUserData;
        break;
      }
    }

    if (matchedUserId && matchedUserData) {
      console.log(`User ${waitingUser.user.name} matched with ${matchedUserData.user.name}`);

      // Deduct tokens if premium users
      const idsToDeduct = [];
      if (waitingUser.user.is_premium) idsToDeduct.push(userId);
      if (matchedUserData.user.is_premium) idsToDeduct.push(matchedUserId);

      if (idsToDeduct.length > 0) {
        try {
          const res = await query('UPDATE users SET tokens = tokens - 8 WHERE id = ANY($1) AND is_premium = true AND tokens >= 8', [idsToDeduct]);
          console.log(`Deducted tokens from users: ${idsToDeduct.join(', ')}`);
        } catch (error) {
          console.error('Token deduction error:', error.message);
        }
      }

      const matchId = `match-${userId}-${matchedUserId}-${Date.now()}`;
      const roomId = `room-${matchId}`

      waitingUsers.delete(userId);
      waitingUsers.delete(matchedUserId);
      activeMatches.set(matchId, { user1Id: userId, user2Id: matchedUserId, roomId, startedAt: Date.now() });

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
    console.error('Error in findMatch:', error);
    return false;
  }
}

async function processMatchingQueue() {
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

          try {
            await query('UPDATE users SET tokens = tokens - 8 WHERE id = ANY($1) AND is_premium = true AND tokens >= 8', [[userId1, userId2]]);
          } catch (error) {
            console.error('Token deduction error:', error);
          }
          break;
        }
      }
    }
  }
}

setInterval(async () => {
  if (waitingUsers.size >= 2) await processMatchingQueue();
}, 5000);

setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of waitingUsers.entries()) {
    if (now - data.joinedAt > 300_000) {
      waitingUsers.delete(userId);
      const userSocket = activeUsers.get(userId);
      if (userSocket) io.to(userSocket.socketId).emit('matchingTimeout', { message: 'No matches found' });
    }
  }
  for (const [roomId, room] of rooms.entries()) {
    if (room.participants.length === 0) rooms.delete(roomId);
  }
}, 60_000);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✨ SwipX Backend running on port ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => process.exit(0));
});
