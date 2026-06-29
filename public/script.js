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

  // ── Screen share ──────────────────────────────────────────────────────────
  let screenStream = null;

  async function toggleScreenShare() {
    // Mobile browsers don't support getDisplayMedia — silently ignore
    if (!navigator.mediaDevices?.getDisplayMedia) return;

    if (screenStream) {
      screenStream.getTracks().forEach(t => t.stop());
      screenStream = null;
      localVideo.srcObject = localStream;
      replaceVideoTrack(localStream.getVideoTracks()[0]);
      showIcon('📷');
      return;
    }
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      localVideo.srcObject = new MediaStream([screenTrack, ...localStream.getAudioTracks()]);
      replaceVideoTrack(screenTrack);
      showIcon('🖥️');
      screenTrack.onended = () => toggleScreenShare();
    } catch (e) {
      // User cancelled picker — ignore silently
    }
  }

  // ── Draggable self-view ───────────────────────────────────────────────────
  const localWrapper = document.getElementById('local-wrapper');
  let dragging = false, dragOX = 0, dragOY = 0;

  localWrapper.addEventListener('pointerdown', (e) => {
    dragging = true;
    localWrapper.setPointerCapture(e.pointerId);
    const r = localWrapper.getBoundingClientRect();
    dragOX = e.clientX - r.left;
    dragOY = e.clientY - r.top;
    e.stopPropagation();
  });

  localWrapper.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const BUFFER = 40; // min px that must stay on screen
    const w = localWrapper.offsetWidth;
    const h = localWrapper.offsetHeight;
    let x = e.clientX - dragOX;
    let y = e.clientY - dragOY;
    // Allow dragging mostly off-screen but keep BUFFER px visible
    x = Math.max(BUFFER - w, Math.min(window.innerWidth  - BUFFER, x));
    y = Math.max(BUFFER - h, Math.min(window.innerHeight - BUFFER, y));
    localWrapper.style.left   = x + 'px';
    localWrapper.style.top    = y + 'px';
    localWrapper.style.right  = 'auto';
    localWrapper.style.bottom = 'auto';
  });

  localWrapper.addEventListener('pointerup',    () => { dragging = false; });
  localWrapper.addEventListener('pointercancel',() => { dragging = false; });

  function replaceVideoTrack(newTrack) {
    Object.values(peers).forEach(({ pc }) => {
      if (!pc) return;
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) sender.replaceTrack(newTrack);
    });
  }

  // ── Gesture detection: tap / double-tap / long-press ─────────────────────
  let tapCount    = 0;
  let tapTimer    = null;
  let pressTimer  = null;
  let longPressed = false;

  // Prevent context menu on long press (mobile)
  document.addEventListener('contextmenu', e => e.preventDefault());

  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#local-wrapper')) return;
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      toggleScreenShare();
    }, 600);
  });

  document.addEventListener('pointerup', () => clearTimeout(pressTimer));
  document.addEventListener('pointercancel', () => clearTimeout(pressTimer));

  // Small movement during hold cancels long press (prevents accidental trigger on scroll)
  document.addEventListener('pointermove', (e) => {
    if (e.movementX ** 2 + e.movementY ** 2 > 100) clearTimeout(pressTimer);
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('#local-wrapper')) return;
    if (longPressed) { longPressed = false; return; } // swallow click after long press
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
