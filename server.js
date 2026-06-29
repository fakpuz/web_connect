const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html for all routes (room IDs handled client-side)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Track rooms: roomId -> [socketId, socketId]
const rooms = {};

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join-room', (roomId) => {
    if (!rooms[roomId]) {
      rooms[roomId] = [];
    }

    const room = rooms[roomId];

    if (room.length >= 2) {
      socket.emit('room-full');
      return;
    }

    room.push(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;

    console.log(`Socket ${socket.id} joined room ${roomId} (${room.length}/2)`);

    if (room.length === 2) {
      // Tell the first peer to initiate the call
      io.to(room[0]).emit('start-call');
    }
  });

  socket.on('offer', (data) => {
    socket.to(data.roomId).emit('offer', { sdp: data.sdp });
  });

  socket.on('answer', (data) => {
    socket.to(data.roomId).emit('answer', { sdp: data.sdp });
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.roomId).emit('ice-candidate', { candidate: data.candidate });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter((id) => id !== socket.id);
      if (rooms[roomId].length === 0) {
        delete rooms[roomId];
      } else {
        socket.to(roomId).emit('peer-left');
      }
    }
    console.log('Client disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
