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
  cors: { origin: FRONTEND_URLS, methods: ["GET", "POST"], credentials: true },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));
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
  const stats = { rooms: rooms.size, matches: activeMatches.size, waiting: waitingUsers.size };
  rooms.clear();
  activeMatches.clear();
  waitingUsers.clear();
  console.log(`🧹 EMERGENCY RESET: Cleared ${stats.rooms} rooms, ${stats.matches} matches, ${stats.waiting} waiting`);
  res.json({ success: true, cleared: stats, message: 'All state cleared successfully' });
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
      if (socket.user.tokens < 1) {
        socket.emit('matchingError', { message: 'Insufficient tokens' });
        return;
      }

      waitingUsers.set(socket.userId, { user: socket.user, preferences, socketId: socket.id, joinedAt: Date.now() });
      socket.emit('matchingStatus', { status: 'searching', message: 'Looking for match...' });

      const matchFound = await findMatch(socket.userId);
      if (!matchFound && waitingUsers.size >= 2) await processMatchingQueue();
    } catch (error) {
      console.error('Error joining queue:', error);
      socket.emit('matchingError', { message: 'Failed to join queue' });
    }
  });

  socket.on('leaveMatchingQueue', () => {
    waitingUsers.delete(socket.userId);
    socket.emit('matchingStatus', { status: 'idle' });
  });

  socket.on('webrtc-offer', (data) => {
    console.log(`📤 Offer from ${socket.user.name}`);
    socket.to(data.roomId).emit('webrtc-offer', { offer: data.offer, from: socket.userId, fromName: socket.user.name });
  });

  socket.on('webrtc-answer', (data) => {
    console.log(`📤 Answer from ${socket.user.name}`);
    socket.to(data.roomId).emit('webrtc-answer', { answer: data.answer, from: socket.userId, fromName: socket.user.name });
  });

  socket.on('ice-candidate', (data) => {
    console.log(`🧊 ICE from ${socket.user.name}`);
    socket.to(data.roomId).emit('ice-candidate', { candidate: data.candidate, from: socket.userId, fromName: socket.user.name });
  });

  socket.on('skipMatch', async (data) => {
    console.log(`⏭️ ${socket.user.name} skipped`);
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
    console.log(`🚪 ${socket.user.name} → ${roomId}`);
    
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      
      if (room.participants.length >= 2 && !room.participants.includes(socket.id)) {
        console.log(`❌ FULL: ${roomId} has ${room.participants.length}`);
        socket.emit('roomFull', { message: 'Room full', roomId });
        return;
      }
      
      if (room.participants.includes(socket.id)) {
        console.log(`⚠️ Already in room`);
        return;
      }
      
      room.participants.push(socket.id);
      socket.join(roomId);
      console.log(`📹 ${socket.user.name} joined (${room.participants.length}/2)`);
      
      if (room.participants.length === 2) {
        io.to(roomId).emit('roomReady', { roomId, matchId, participants: 2 });
        console.log(`✅ Room ${roomId} ready (2 participants)`);
      }
    } else {
      rooms.set(roomId, { participants: [socket.id], matchId, createdAt: Date.now(), maxParticipants: 2 });
      socket.join(roomId);
      console.log(`📹 ${socket.user.name} created room (1/2)`);
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
      console.error('Message error:', error);
      socket.emit('messageError', { message: 'Failed to send' });
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
      console.error('Status update error:', error);
    }
  });

  socket.on('disconnect', async () => {
    console.log(`🔴 ${socket.user.name} disconnected`);
    activeUsers.delete(socket.userId);
    waitingUsers.delete(socket.userId);
    
    try {
      await query('UPDATE users SET is_online = false, last_seen = CURRENT_TIMESTAMP WHERE id = $1', [socket.userId]);
    } catch (error) {
      console.error('Disconnect update error:', error);
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
      const matchId = `match-${userId}-${matchedUserId}-${Date.now()}`;
      const roomId = `room-${matchId}`;
      
      waitingUsers.delete(userId);
      waitingUsers.delete(matchedUserId);
      activeMatches.set(matchId, { user1Id: userId, user2Id: matchedUserId, roomId, startedAt: Date.now() });
      
      const user1Socket = activeUsers.get(userId);
      const user2Socket = activeUsers.get(matchedUserId);
      
      if (user1Socket && user2Socket) {
        io.to(user1Socket.socketId).emit('matchFound', {
          matchId, roomId,
          partner: { id: matchedUserId, name: matchedUserData.user.name, age: matchedUserData.user.age, country: matchedUserData.user.country, gender: matchedUserData.user.gender, avatar_url: matchedUserData.user.avatar_url },
          isInitiator: true
        });
        
        io.to(user2Socket.socketId).emit('matchFound', {
          matchId, roomId,
          partner: { id: userId, name: waitingUser.user.name, age: waitingUser.user.age, country: waitingUser.user.country, gender: waitingUser.user.gender, avatar_url: waitingUser.user.avatar_url },
          isInitiator: false
        });
        
        try {
          await query('UPDATE users SET tokens = tokens - 1 WHERE id IN ($1, $2) AND tokens > 0', [userId, matchedUserId]);
        } catch (error) {
          console.log('Token deduction warning:', error.message);
        }
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error('Match error:', error);
    return false;
  }
}

async function processMatchingQueue() {
  // Similar to findMatch but processes multiple pairs
  // [Code continues as before...]
}

setInterval(async () => {
  if (waitingUsers.size >= 2) await processMatchingQueue();
}, 5000);

setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of waitingUsers.entries()) {
    if (now - data.joinedAt > 300000) {
      waitingUsers.delete(userId);
      const userSocket = activeUsers.get(userId);
      if (userSocket) io.to(userSocket.socketId).emit('matchingTimeout', { message: 'No matches found' });
    }
  }
  for (const [roomId, room] of rooms.entries()) {
    if (room.participants.length === 0) rooms.delete(roomId);
  }
}, 60000);

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ success: false, message: 'Internal error' });
});

app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✨ SwipX Backend on port ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
