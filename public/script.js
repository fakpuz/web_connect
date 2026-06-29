(() => {
  const FIXED_ROOM = 'main';
  const STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

  const remoteGrid  = document.getElementById('remote-grid');
  const localVideo  = document.getElementById('local-video');
  const waitingMsg  = document.getElementById('waiting-msg');
  const gestureIcon = document.getElementById('gesture-icon');
  const toast       = document.getElementById('toast');

  let localStream = null;
  let audioMuted  = false;
  let videoOff    = false;
  const socket    = io();

  // peerId -> { pc, cell, video }
  const peers = {};

  // ── Helpers ───────────────────────────────────────────────────────────────
  function showToast(msg, ms = 3000) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toast.classList.add('hidden'), ms);
  }

  function showIcon(emoji) {
    gestureIcon.textContent = emoji;
    gestureIcon.classList.remove('hidden', 'fade');
    void gestureIcon.offsetWidth;
    requestAnimationFrame(() => gestureIcon.classList.add('fade'));
    clearTimeout(gestureIcon._t);
    gestureIcon._t = setTimeout(() => gestureIcon.classList.add('hidden'), 650);
  }

  function updateGrid() {
    const n = Object.keys(peers).length;
    remoteGrid.className = n > 0 ? `n${Math.min(n, 4)}` : '';
    waitingMsg.style.display = n === 0 ? 'flex' : 'none';
  }

  // ── Create/remove remote video cell ──────────────────────────────────────
  function addRemoteVideo(peerId) {
    if (peers[peerId]?.cell) return;
    const cell = document.createElement('div');
    cell.className = 'remote-cell';
    cell.id = `peer-${peerId}`;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    cell.appendChild(video);
    remoteGrid.appendChild(cell);
    if (!peers[peerId]) peers[peerId] = {};
    peers[peerId].cell  = cell;
    peers[peerId].video = video;
    updateGrid();
    return video;
  }

  function removeRemoteVideo(peerId) {
    if (peers[peerId]?.cell) peers[peerId].cell.remove();
    if (peers[peerId]?.pc)   peers[peerId].pc.close();
    delete peers[peerId];
    updateGrid();
  }

  // ── Peer connection ───────────────────────────────────────────────────────
  function createPC(peerId) {
    const pc = new RTCPeerConnection(STUN);
    if (!peers[peerId]) peers[peerId] = {};
    peers[peerId].pc = pc;

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.ontrack = (e) => {
      const video = peers[peerId]?.video || addRemoteVideo(peerId);
      video.srcObject = e.streams[0];
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('ice-candidate', { to: peerId, candidate: e.candidate });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        removeRemoteVideo(peerId);
      }
    };

    return pc;
  }

  // ── Signaling ─────────────────────────────────────────────────────────────
  // We are the newcomer — initiate offers to everyone already in the room
  socket.on('existing-peers', async (peerIds) => {
    for (const peerId of peerIds) {
      addRemoteVideo(peerId);
      const pc = createPC(peerId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: peerId, sdp: pc.localDescription });
    }
  });

  // Someone new joined — they'll send us an offer, just wait
  socket.on('peer-joined', (peerId) => {
    addRemoteVideo(peerId);
  });

  socket.on('offer', async ({ from, sdp }) => {
    const pc = createPC(from);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: from, sdp: pc.localDescription });
  });

  socket.on('answer', async ({ from, sdp }) => {
    await peers[from]?.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    try { await peers[from]?.pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.error(e); }
  });

  socket.on('peer-left', (peerId) => {
    removeRemoteVideo(peerId);
    showToast('Someone left the call.');
  });

  socket.on('room-full', () => showToast('Room is full (max 4 people).'));

  // ── Gesture controls ──────────────────────────────────────────────────────
  function toggleMute() {
    audioMuted = !audioMuted;
    localStream?.getAudioTracks().forEach(t => t.enabled = !audioMuted);
    showIcon(audioMuted ? '🔇' : '🎤');
  }

  function toggleCamera() {
    videoOff = !videoOff;
    localStream?.getVideoTracks().forEach(t => t.enabled = !videoOff);
    showIcon(videoOff ? '📵' : '📷');
  }

  let tapCount = 0, tapTimer = null;
  document.addEventListener('click', (e) => {
    if (e.target.closest('#local-wrapper')) return;
    tapCount++;
    if (tapCount === 1) {
      tapTimer = setTimeout(() => { tapCount = 0; toggleMute(); }, 260);
    } else {
      clearTimeout(tapTimer);
      tapCount = 0;
      toggleCamera();
    }
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', async () => {
    // Fix mobile viewport height
    const setVh = () => document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
    setVh();
    window.addEventListener('resize', setVh);

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
    } catch {
      showToast('Camera/mic access denied. Allow permissions and reload.');
      return;
    }
    socket.emit('join-room', FIXED_ROOM);
  });
})();
