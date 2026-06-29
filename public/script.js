(() => {
  const FIXED_ROOM = 'main';
  const STUN_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  const localVideo   = document.getElementById('local-video');
  const remoteVideo  = document.getElementById('remote-video');
  const waitingMsg   = document.getElementById('waiting-msg');
  const gestureIcon  = document.getElementById('gesture-icon');
  const toast        = document.getElementById('toast');

  let localStream = null;
  let pc          = null;
  let audioMuted  = false;
  let videoOff    = false;
  const socket    = io();

  // ── Toast ─────────────────────────────────────────────────────────────────
  function showToast(msg, duration = 3000) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toast.classList.add('hidden'), duration);
  }

  // ── Gesture icon (fades out after showing) ────────────────────────────────
  function showIcon(emoji) {
    gestureIcon.textContent = emoji;
    gestureIcon.classList.remove('hidden', 'fade');
    // Force reflow so transition re-fires
    void gestureIcon.offsetWidth;
    requestAnimationFrame(() => {
      gestureIcon.classList.add('fade');
    });
    clearTimeout(gestureIcon._t);
    gestureIcon._t = setTimeout(() => gestureIcon.classList.add('hidden'), 600);
  }

  // ── Media ─────────────────────────────────────────────────────────────────
  async function getLocalMedia() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
    } catch (err) {
      showToast('Camera/mic access denied. Please allow and reload.');
      console.error(err);
    }
  }

  // ── Controls (tap / double-tap) ───────────────────────────────────────────
  function toggleMute() {
    audioMuted = !audioMuted;
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !audioMuted);
    showIcon(audioMuted ? '🔇' : '🎤');
  }

  function toggleCamera() {
    videoOff = !videoOff;
    if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = !videoOff);
    showIcon(videoOff ? '📵' : '📷');
  }

  // Tap detection: single tap = mute, double tap = camera
  let tapCount = 0;
  let tapTimer  = null;

  document.addEventListener('click', (e) => {
    // Ignore clicks on the local PiP (accidental)
    if (e.target.closest('#local-wrapper')) return;

    tapCount++;
    if (tapCount === 1) {
      tapTimer = setTimeout(() => {
        tapCount = 0;
        toggleMute();
      }, 260);
    } else if (tapCount >= 2) {
      clearTimeout(tapTimer);
      tapCount = 0;
      toggleCamera();
    }
  });

  // ── WebRTC ────────────────────────────────────────────────────────────────
  function createPeerConnection() {
    pc = new RTCPeerConnection(STUN_SERVERS);
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.ontrack = (e) => {
      remoteVideo.srcObject = e.streams[0];
      waitingMsg.style.display = 'none';
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('ice-candidate', { roomId: FIXED_ROOM, candidate: e.candidate });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        showToast('The other person left.');
        waitingMsg.style.display = 'flex';
        remoteVideo.srcObject = null;
      }
    };
  }

  // ── Socket signaling ──────────────────────────────────────────────────────
  socket.on('start-call', async () => {
    createPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { roomId: FIXED_ROOM, sdp: pc.localDescription });
  });

  socket.on('offer', async ({ sdp }) => {
    createPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { roomId: FIXED_ROOM, sdp: pc.localDescription });
  });

  socket.on('answer', async ({ sdp }) => {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  });

  socket.on('ice-candidate', async ({ candidate }) => {
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.error(e); }
  });

  socket.on('peer-left', () => {
    showToast('The other person left.');
    waitingMsg.style.display = 'flex';
    remoteVideo.srcObject = null;
    if (pc) { pc.close(); pc = null; }
  });

  socket.on('room-full', () => showToast('Room is busy — only 2 people at a time.'));

  // ── Start ─────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', async () => {
    await getLocalMedia();
    if (localStream) socket.emit('join-room', FIXED_ROOM);
  });
})();
