(() => {
  const FIXED_ROOM  = 'main';
  const STUN        = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
  const DRAG_BUFFER = 40;     // min px that must stay on-screen for any panel
  const LOCAL_SIZE  = 0.22;   // self-view = 22% of screen width

  const app         = document.getElementById('app');
  const localPanel  = document.getElementById('local-panel');
  const localVideo  = document.getElementById('local-video');
  const waitingMsg  = document.getElementById('waiting-msg');
  const gestureIcon = document.getElementById('gesture-icon');
  const toast       = document.getElementById('toast');

  let localStream = null;
  let audioMuted  = false;
  let videoOff    = false;
  const socket    = io();
  const peers     = {}; // peerId -> { pc, panel, video }

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

  // ── Smart layout ──────────────────────────────────────────────────────────
  // Score a cell: how much of it can a 16:9 video fill?
  function videoScore(cw, ch) {
    const R = 16 / 9;
    return Math.min(cw, ch * R) * Math.min(ch, cw / R);
  }

  // Return [{x,y,w,h}] for n remote videos, picking the best arrangement
  function computeLayout(n) {
    const W = window.innerWidth;
    const H = window.innerHeight;

    if (n === 0) return [];
    if (n === 1) return [{ x: 0, y: 0, w: W, h: H }];

    const candidates = [];

    // Uniform grids: try all cols that divide evenly
    for (let cols = 1; cols <= n; cols++) {
      if (n % cols !== 0) continue;
      const rows = n / cols;
      const cw = W / cols, ch = H / rows;
      const score = videoScore(cw, ch);
      const pos = [];
      for (let i = 0; i < n; i++)
        pos.push({ x: (i % cols) * cw, y: Math.floor(i / cols) * ch, w: cw, h: ch });
      candidates.push({ score, pos });
    }

    // For n=3: try uneven splits
    if (n === 3) {
      const layouts3 = [
        // 2 top + 1 bottom full-width
        [{ x:0, y:0, w:W/2, h:H*2/3 }, { x:W/2, y:0,    w:W/2, h:H*2/3 }, { x:0, y:H*2/3, w:W,   h:H/3   }],
        // 1 top full-width + 2 bottom
        [{ x:0, y:0, w:W,   h:H/3   }, { x:0,   y:H/3,  w:W/2, h:H*2/3 }, { x:W/2, y:H/3, w:W/2, h:H*2/3 }],
        // 1 left full-height + 2 right stacked
        [{ x:0, y:0, w:W/2, h:H     }, { x:W/2, y:0,    w:W/2, h:H/2   }, { x:W/2, y:H/2, w:W/2, h:H/2   }],
        // 2 left stacked + 1 right full-height
        [{ x:0, y:0, w:W/2, h:H/2   }, { x:0,   y:H/2,  w:W/2, h:H/2   }, { x:W/2, y:0,   w:W/2, h:H     }],
      ];
      layouts3.forEach(pos => {
        // score = area of the smallest video (bottleneck)
        const score = Math.min(...pos.map(p => videoScore(p.w, p.h)));
        candidates.push({ score, pos });
      });
    }

    // Pick best
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].pos;
  }

  function layoutRemoteVideos() {
    const entries = Object.entries(peers).filter(([, p]) => p.panel);
    const n = entries.length;
    waitingMsg.style.display = n === 0 ? 'flex' : 'none';
    if (n === 0) return;

    const positions = computeLayout(n);
    entries.forEach(([, peer], i) => {
      const p = positions[i];
      Object.assign(peer.panel.style, {
        left: p.x + 'px', top: p.y + 'px',
        width: p.w + 'px', height: p.h + 'px',
        right: 'auto', bottom: 'auto',
      });
    });
  }

  window.addEventListener('resize', () => {
    layoutRemoteVideos();
    placeLocalPanel();
  });

  // ── Local panel initial placement ─────────────────────────────────────────
  function placeLocalPanel() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const w = Math.min(Math.max(W * LOCAL_SIZE, 80), 200);
    const h = w * 9 / 16;
    Object.assign(localPanel.style, {
      width:  w + 'px',
      height: h + 'px',
      right:  '2%',
      bottom: '2%',
      left:   'auto',
      top:    'auto',
    });
  }

  // ── Universal drag — all vid-panels, can go partially off-screen ──────────
  function makeDraggable(el) {
    let dragging = false, ox = 0, oy = 0;

    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      el.setPointerCapture(e.pointerId);
      const r = el.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      el.style.zIndex = 50; // bring to front while dragging
      e.stopPropagation();
    });

    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const w = el.offsetWidth, h = el.offsetHeight;
      const B = DRAG_BUFFER;
      const x = Math.max(B - w, Math.min(window.innerWidth  - B, e.clientX - ox));
      const y = Math.max(B - h, Math.min(window.innerHeight - B, e.clientY - oy));
      Object.assign(el.style, { left: x+'px', top: y+'px', right: 'auto', bottom: 'auto' });
    });

    el.addEventListener('pointerup',    () => { dragging = false; el.style.zIndex = ''; });
    el.addEventListener('pointercancel',() => { dragging = false; el.style.zIndex = ''; });
  }

  // ── Remote peer management ────────────────────────────────────────────────
  function addRemotePanel(peerId) {
    if (peers[peerId]?.panel) return;
    const panel = document.createElement('div');
    panel.className = 'vid-panel';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    panel.appendChild(video);
    app.appendChild(panel);
    if (!peers[peerId]) peers[peerId] = {};
    peers[peerId].panel = panel;
    peers[peerId].video = video;
    makeDraggable(panel);
    layoutRemoteVideos();
  }

  function removeRemotePanel(peerId) {
    peers[peerId]?.panel?.remove();
    peers[peerId]?.pc?.close();
    delete peers[peerId];
    layoutRemoteVideos();
  }

  // ── WebRTC ────────────────────────────────────────────────────────────────
  function createPC(peerId) {
    const pc = new RTCPeerConnection(STUN);
    if (!peers[peerId]) peers[peerId] = {};
    peers[peerId].pc = pc;

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.ontrack = (e) => {
      if (!peers[peerId]?.panel) addRemotePanel(peerId);
      peers[peerId].video.srcObject = e.streams[0];
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('ice-candidate', { to: peerId, candidate: e.candidate });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')
        removeRemotePanel(peerId);
    };
    return pc;
  }

  // ── Signaling ─────────────────────────────────────────────────────────────
  socket.on('existing-peers', async (peerIds) => {
    for (const peerId of peerIds) {
      addRemotePanel(peerId);
      const pc    = createPC(peerId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: peerId, sdp: pc.localDescription });
    }
  });

  socket.on('peer-joined', (peerId) => addRemotePanel(peerId));

  socket.on('offer', async ({ from, sdp }) => {
    const pc     = createPC(from);
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

  socket.on('peer-left',  (id) => { removeRemotePanel(id); showToast('Someone left.'); });
  socket.on('room-full',  ()   => showToast('Room is full (max 4 people).'));

  // ── Screen share ──────────────────────────────────────────────────────────
  let screenStream = null;

  async function toggleScreenShare() {
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
      const track  = screenStream.getVideoTracks()[0];
      localVideo.srcObject = new MediaStream([track, ...localStream.getAudioTracks()]);
      replaceVideoTrack(track);
      showIcon('🖥️');
      track.onended = () => toggleScreenShare();
    } catch (_) {}
  }

  function replaceVideoTrack(newTrack) {
    Object.values(peers).forEach(({ pc }) => {
      const sender = pc?.getSenders().find(s => s.track?.kind === 'video');
      if (sender) sender.replaceTrack(newTrack);
    });
  }

  // ── Gesture detection — tap / double-tap / long-press ─────────────────────
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
  let pressTimer = null, longPressed = false;
  let pressX = 0, pressY = 0, pressTime = 0;

  document.addEventListener('contextmenu', e => e.preventDefault());

  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.vid-panel')) return; // panels handle their own events
    pressX = e.clientX; pressY = e.clientY; pressTime = Date.now();
    longPressed = false;
    pressTimer  = setTimeout(() => { longPressed = true; toggleScreenShare(); }, 600);
  });

  document.addEventListener('pointermove', (e) => {
    if (e.target.closest('.vid-panel')) return;
    const dx = e.clientX - pressX, dy = e.clientY - pressY;
    if (dx * dx + dy * dy > 64) clearTimeout(pressTimer);
  });

  document.addEventListener('pointercancel', () => clearTimeout(pressTimer));

  document.addEventListener('pointerup', (e) => {
    clearTimeout(pressTimer);
    if (e.target.closest('.vid-panel')) return;
    if (longPressed) { longPressed = false; return; }

    const dx = e.clientX - pressX, dy = e.clientY - pressY;
    if (dx * dx + dy * dy > 64 || Date.now() - pressTime > 300) return;

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
    placeLocalPanel();
    makeDraggable(localPanel);

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
