const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const MAX_PEERS = 4;

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// roomId -> Set of socketIds
const rooms = {};

io.on('connection', (socket) => {
  socket.on('join-room', (roomId) => {
    if (!rooms[roomId]) rooms[roomId] = new Set();
    const room = rooms[roomId];

    if (room.size >= MAX_PEERS) {
      socket.emit('room-full');
      return;
    }

    // Tell newcomer about everyone already in room
    socket.emit('existing-peers', [...room]);

    // Tell everyone else about the newcomer
    room.forEach(peerId => io.to(peerId).emit('peer-joined', socket.id));

    room.add(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;
    console.log(`${socket.id} joined ${roomId} (${room.size}/${MAX_PEERS})`);
  });

  // Relay signals between specific peers
  socket.on('offer',         ({ to, sdp })       => io.to(to).emit('offer',         { from: socket.id, sdp }));
  socket.on('answer',        ({ to, sdp })        => io.to(to).emit('answer',        { from: socket.id, sdp }));
  socket.on('ice-candidate', ({ to, candidate })  => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));
  socket.on('camera-state',  (data)              => socket.to(socket.data.roomId).emit('camera-state', { from: socket.id, ...data }));

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId].delete(socket.id);
      if (rooms[roomId].size === 0) delete rooms[roomId];
      else io.to(roomId).emit('peer-left', socket.id);
    }
    console.log(`${socket.id} disconnected`);
  });
});

server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
