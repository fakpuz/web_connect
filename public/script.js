(() => {
  const FIXED_ROOM  = 'main';
  const STUN        = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
  const DRAG_BUFFER = 40;
  const LOCAL_SIZE  = 0.22;

  const app         = document.getElementById('app');
  const localPanel  = document.getElementById('local-panel');
  const localVideo  = document.getElementById('local-video');
  const waitingMsg  = document.getElementById('waiting-msg');
  const ctrlPanel   = document.getElementById('ctrl-panel');
  const btnMic      = document.getElementById('btn-mic');
  const btnCam      = document.getElementById('btn-cam');
  const btnVoice    = document.getElementById('btn-voice');
  const btnShare    = document.getElementById('btn-share');
  const toast       = document.getElementById('toast');

  let localStream = null;
  let audioMuted  = false;
  let videoOff    = false;
  let voiceOnly       = false;
  let voiceOnlyPreCam = false; // was camera on before entering voice-only?
  const socket    = io();
  const peers     = {}; // peerId -> { pc, panel, video, cell }
  let   zTop      = 10; // increments on every touch; touched panel always wins

  // ── Helpers ───────────────────────────────────────────────────────────────
  function showToast(msg, ms = 3000) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toast.classList.add('hidden'), ms);
  }

  function showIcon(_emoji) {} // kept for call-sites; no-op now

  // ── Fit panel exactly to video's natural ratio — zero black bars ──────────
  // cell = {x, y, w, h} — the allocated screen region
  // The panel is sized to the largest rect that fits in cell at the video's ratio,
  // then centered. This means pure video pixels fill the panel; no letterbox.
  function fitToRatio(panel, video, cell) {
    const ratio = (video.videoWidth && video.videoHeight)
      ? video.videoWidth / video.videoHeight
      : 16 / 9;
    const { x, y, w, h } = cell;
    let pw, ph;
    if (w / h >= ratio) { ph = h; pw = ph * ratio; }
    else                 { pw = w; ph = pw / ratio; }
    Object.assign(panel.style, {
      left:   (x + (w - pw) / 2) + 'px',
      top:    (y + (h - ph) / 2) + 'px',
      width:  pw + 'px',
      height: ph + 'px',
      right:  'auto',
      bottom: 'auto',
    });
  }

  // ── Smart layout — returns [{x,y,w,h}] for n slots ───────────────────────
  function videoScore(cw, ch) {
    const R = 16 / 9;
    return Math.min(cw, ch * R) * Math.min(ch, cw / R);
  }

  function computeLayout(n) {
    const W = window.innerWidth, H = window.innerHeight;
    if (n === 0) return [];
    if (n === 1) return [{ x: 0, y: 0, w: W, h: H }];

    const candidates = [];

    for (let cols = 1; cols <= n; cols++) {
      if (n % cols !== 0) continue;
      const rows = n / cols;
      const cw = W / cols, ch = H / rows;
      const pos = [];
      for (let i = 0; i < n; i++)
        pos.push({ x: (i % cols) * cw, y: Math.floor(i / cols) * ch, w: cw, h: ch });
      candidates.push({ score: videoScore(cw, ch), pos });
    }

    if (n === 3) {
      [
        [{ x:0, y:0, w:W/2, h:H*2/3 }, { x:W/2, y:0,   w:W/2, h:H*2/3 }, { x:0, y:H*2/3, w:W,   h:H/3   }],
        [{ x:0, y:0, w:W,   h:H/3   }, { x:0,   y:H/3, w:W/2, h:H*2/3 }, { x:W/2, y:H/3, w:W/2, h:H*2/3 }],
        [{ x:0, y:0, w:W/2, h:H     }, { x:W/2, y:0,   w:W/2, h:H/2   }, { x:W/2, y:H/2, w:W/2, h:H/2   }],
        [{ x:0, y:0, w:W/2, h:H/2   }, { x:0,   y:H/2, w:W/2, h:H/2   }, { x:W/2, y:0,   w:W/2, h:H     }],
      ].forEach(pos => candidates.push({ score: Math.min(...pos.map(p => videoScore(p.w, p.h))), pos }));
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].pos;
  }

  function layoutRemoteVideos() {
    const all     = Object.entries(peers).filter(([, p]) => p.panel);
    const visible = all.filter(([, p]) => !p.cameraOff && !p.wantsVoiceOnly && !voiceOnly);
    all.forEach(([, p]) => { if (p.panel) p.panel.style.display = (p.cameraOff || p.wantsVoiceOnly || voiceOnly) ? 'none' : ''; });

    // Waiting msg: only when truly no one is connected
    const totalPeers = all.length;
    waitingMsg.style.display = (totalPeers === 0 && !voiceOnly) ? 'flex' : 'none';

    if (visible.length > 0) {
      const positions = computeLayout(visible.length);
      visible.forEach(([id, peer], i) => {
        peer.cell = positions[i];
        fitToRatio(peer.panel, peer.video, peer.cell);
      });
    }

    updateStatusBar();
  }

  function updateStatusBar() {
    const totalPeers  = Object.keys(peers).length;
    if (totalPeers === 0) { statusBar.classList.add('hidden'); return; }

    const voicePeers  = Object.values(peers).filter(p => p.wantsVoiceOnly).length;
    const videoPeers  = totalPeers - voicePeers;

    // Include self in counts
    const totalVideo  = videoPeers  + (voiceOnly ? 0 : 1);
    const totalVoice  = voicePeers  + (voiceOnly ? 1 : 0);

    const parts = [];
    if (totalVideo > 0) parts.push(`📹 ${totalVideo} in video`);
    if (totalVoice > 0) parts.push(`🎙️ ${totalVoice} voice only`);

    statusBar.textContent = parts.join('  ·  ');
    statusBar.classList.remove('hidden');
  }

  function clampAllPanels() {
    document.querySelectorAll('.vid-panel').forEach(el => {
      // Skip hidden or focused (focused gets its own resize handling)
      if (el.classList.contains('panel-hidden') || el.classList.contains('panel-focused')) return;
      // Skip panels still using right/bottom CSS positioning (not yet manually placed)
      if (!el.style.left || el.style.left === 'auto') return;
      const w = el.offsetWidth, h = el.offsetHeight, B = DRAG_BUFFER;
      const x = Math.max(B - w, Math.min(window.innerWidth  - B, parseFloat(el.style.left)));
      const y = Math.max(B - h, Math.min(window.innerHeight - B, parseFloat(el.style.top)));
      Object.assign(el.style, { left: x+'px', top: y+'px', right: 'auto', bottom: 'auto' });
    });
  }

  window.addEventListener('resize', () => {
    if (focusedPanel) {
      // Keep focused panel filling the new viewport
      Object.assign(focusedPanel.style, {
        left: '0px', top: '0px',
        width: window.innerWidth  + 'px',
        height: window.innerHeight + 'px',
      });
    }
    layoutRemoteVideos();
    fitLocalPanel();
    clampAllPanels();
  });

  // ── Local panel ───────────────────────────────────────────────────────────
  function fitLocalPanel() {
    const W = window.innerWidth;
    const w = Math.min(Math.max(W * LOCAL_SIZE, 80), 200);
    // use actual camera ratio if available, else 4:3
    const ratio = (localVideo.videoWidth && localVideo.videoHeight)
      ? localVideo.videoWidth / localVideo.videoHeight
      : 4 / 3;
    const h = w / ratio;
    // only reposition if not manually dragged (top/left still 'auto')
    const hasBeenDragged = localPanel.style.left && localPanel.style.left !== 'auto';
    Object.assign(localPanel.style, { width: w + 'px', height: h + 'px' });
    if (!hasBeenDragged) {
      Object.assign(localPanel.style, { right: '2%', bottom: '2%', left: 'auto', top: 'auto' });
    }
  }

  localVideo.addEventListener('loadedmetadata', fitLocalPanel);

  // ── Panel focus (double-tap expands to full screen) ──────────────────────
  let focusedPanel = null;

  function togglePanelFocus(el) {
    if (focusedPanel === el) {
      // Exit focus: restore saved position/size
      el.classList.remove('panel-focused');
      if (el._saved) { Object.assign(el.style, el._saved); el._saved = null; }
      document.querySelectorAll('.vid-panel').forEach(p => p.classList.remove('panel-hidden'));
      focusedPanel = null;
    } else {
      // Exit any existing focus first
      if (focusedPanel) togglePanelFocus(focusedPanel);
      focusedPanel = el;
      // Save current geometry
      el._saved = { left: el.style.left, top: el.style.top,
                    width: el.style.width, height: el.style.height,
                    right: el.style.right, bottom: el.style.bottom,
                    zIndex: el.style.zIndex };
      // Expand to fill screen
      Object.assign(el.style, {
        left: '0px', top: '0px',
        width: window.innerWidth  + 'px',
        height: window.innerHeight + 'px',
        right: 'auto', bottom: 'auto',
        zIndex: ++zTop,
      });
      el.classList.add('panel-focused');
      // Hide all other panels
      document.querySelectorAll('.vid-panel').forEach(p => {
        if (p !== el) p.classList.add('panel-hidden');
      });
    }
  }

  // ── Drag (1 pointer) + pinch-zoom (2 pointers) + double-tap focus ─────────
  function makeInteractive(el) {
    const pts = new Map(); // pointerId → {x, y}
    let mode = 'idle';     // 'drag' | 'pinch'
    let ox = 0, oy = 0;
    let pinchDist0 = 0, pinchW0 = 0, pinchH0 = 0;
    let tapCount = 0, tapTimer = null;
    let pressX = 0, pressY = 0, pressTime = 0, didMove = false;

    function pinchStart() {
      const [a, b] = [...pts.values()];
      pinchDist0 = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      pinchW0    = el.offsetWidth;
      pinchH0    = el.offsetHeight;
    }

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.style.zIndex = ++zTop;
      e.stopPropagation();

      if (pts.size === 1) {
        mode = 'drag';
        pressX = e.clientX; pressY = e.clientY;
        pressTime = Date.now(); didMove = false;
        const r = el.getBoundingClientRect();
        ox = e.clientX - r.left;
        oy = e.clientY - r.top;
      } else if (pts.size === 2) {
        mode = 'pinch';
        pinchStart();
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

      const dx = e.clientX - pressX, dy = e.clientY - pressY;
      if (dx*dx + dy*dy > 64) didMove = true;

      if (mode === 'drag') {
        const w = el.offsetWidth, h = el.offsetHeight, B = DRAG_BUFFER;
        const x = Math.max(B - w, Math.min(window.innerWidth  - B, e.clientX - ox));
        const y = Math.max(B - h, Math.min(window.innerHeight - B, e.clientY - oy));
        Object.assign(el.style, { left: x+'px', top: y+'px', right: 'auto', bottom: 'auto' });
      } else if (mode === 'pinch') {
        const [a, b] = [...pts.values()];
        const dist  = Math.hypot(b.x - a.x, b.y - a.y);
        const scale = dist / pinchDist0;
        const ratio = pinchW0 / pinchH0;
        const newW  = Math.max(80, Math.min(window.innerWidth * 1.8, pinchW0 * scale));
        const newH  = newW / ratio;
        const cx    = el.offsetLeft + el.offsetWidth  / 2;
        const cy    = el.offsetTop  + el.offsetHeight / 2;
        Object.assign(el.style, {
          width: newW+'px', height: newH+'px',
          left: (cx - newW/2)+'px', top: (cy - newH/2)+'px',
          right: 'auto', bottom: 'auto',
        });
      }
    });

    const onEnd = (e) => {
      // Detect tap on single-finger lift
      if (pts.size === 1 && !didMove && Date.now() - pressTime < 400) {
        tapCount++;
        clearTimeout(tapTimer);
        if (tapCount >= 2) {
          tapCount = 0;
          togglePanelFocus(el);
        } else {
          tapTimer = setTimeout(() => { tapCount = 0; }, 350);
        }
      }

      pts.delete(e.pointerId);
      if (pts.size === 0) {
        mode = 'idle';
      } else if (pts.size === 1) {
        mode = 'drag';
        const [, pos] = [...pts.entries()][0];
        const r = el.getBoundingClientRect();
        ox = pos.x - r.left; oy = pos.y - r.top;
      }
    };
    el.addEventListener('pointerup',     onEnd);
    el.addEventListener('pointercancel', onEnd);
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
    peers[peerId].cell  = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    makeInteractive(panel);
    // Re-fit when we learn the real video ratio
    video.addEventListener('loadedmetadata', () => {
      if (peers[peerId]?.cell) fitToRatio(panel, video, peers[peerId].cell);
    });
    video.addEventListener('resize', () => {
      if (peers[peerId]?.cell) fitToRatio(panel, video, peers[peerId].cell);
    });
    layoutRemoteVideos();
  }

  function removeRemotePanel(peerId) {
    peers[peerId]?.panel?.remove();
    peers[peerId]?.pc?.close();
    delete peers[peerId];
    delete peerNumbers[peerId];
    layoutRemoteVideos();
    updateVoiceIndicators();
  }

  // ── WebRTC ────────────────────────────────────────────────────────────────
  function createPC(peerId) {
    const pc = new RTCPeerConnection(STUN);
    if (!peers[peerId]) peers[peerId] = {};
    peers[peerId].pc = pc;
    localStream.getTracks().forEach(t => {
      const sender = pc.addTrack(t, localStream);
      if (t.kind === 'video') peers[peerId].videoSender = sender;
    });
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
    catch (_) {}
  });

  socket.on('camera-state', ({ from, videoOff: off }) => {
    if (!peers[from]) return;
    peers[from].cameraOff = off;
    layoutRemoteVideos();
  });

  // ── Voice-only peer indicators ────────────────────────────────────────────
  const statusBar       = document.getElementById('status-bar');
  const voiceOverlay    = document.getElementById('voice-overlay');
  const voiceIndicators = document.getElementById('voice-indicators');

  voiceOverlay.addEventListener('click', () => { if (voiceOnly) toggleVoiceOnly(); });
  let peerNumbers = {}; // peerId → display number
  let peerCounter = 0;

  function getPeerNumber(id) {
    if (!peerNumbers[id]) peerNumbers[id] = ++peerCounter;
    return peerNumbers[id];
  }

  function updateVoiceIndicators() {
    voiceIndicators.innerHTML = '';
    Object.entries(peers).forEach(([id, p]) => {
      if (!p.wantsVoiceOnly) return;
      const el = document.createElement('div');
      el.className = 'voice-bubble';
      el.textContent = `🎙️  Person ${getPeerNumber(id)} — voice only`;
      voiceIndicators.appendChild(el);
    });
  }

  // Peer wants voice-only: stop sending video to them (saves their bandwidth)
  socket.on('voice-only', ({ from }) => {
    const peer = peers[from];
    if (!peer) return;
    peer.wantsVoiceOnly = true;
    if (peer.videoSender) peer.videoSender.replaceTrack(null);
    updateVoiceIndicators();
    layoutRemoteVideos();
  });

  socket.on('voice-only-off', ({ from }) => {
    const peer = peers[from];
    if (!peer) return;
    peer.wantsVoiceOnly = false;
    if (peer.videoSender && !videoOff) {
      const track = (screenStream || localStream)?.getVideoTracks()[0];
      if (track) peer.videoSender.replaceTrack(track);
    }
    updateVoiceIndicators();
    layoutRemoteVideos();
  });

  socket.on('peer-left',  (id) => { removeRemotePanel(id); showToast('Someone left.'); });
  socket.on('room-full',  ()   => showToast('Room is full (max 4 people).'));

  // ── Screen share ──────────────────────────────────────────────────────────
  let screenStream = null;

  function stopScreenShare() {
    if (!screenStream) return;
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
    localVideo.srcObject = localStream;
    const camTrack = localStream?.getVideoTracks()[0];
    if (camTrack) replaceVideoTrack(camTrack);
    updateCtrlUI();
  }

  async function toggleScreenShare() {
    if (screenStream) { stopScreenShare(); return; }

    // Some mobile browsers put getDisplayMedia on navigator directly (not mediaDevices)
    const gdm = navigator.mediaDevices?.getDisplayMedia?.bind(navigator.mediaDevices)
             || navigator.getDisplayMedia?.bind(navigator);

    if (!gdm) {
      showToast('Screen share is not supported on mobile browsers');
      return;
    }
    try {
      screenStream = await gdm({ video: { frameRate: { ideal: 30 } }, audio: false });
      const track = screenStream.getVideoTracks()[0];
      localVideo.srcObject = new MediaStream([track, ...(localStream?.getAudioTracks() ?? [])]);
      replaceVideoTrack(track);
      updateCtrlUI();
      track.onended = stopScreenShare;
    } catch (err) {
      screenStream = null;
      updateCtrlUI();
      if (err.name !== 'NotAllowedError') showToast('Screen share failed: ' + (err.message || err.name));
    }
  }

  function replaceVideoTrack(newTrack) {
    Object.values(peers).forEach((peer) => {
      if (peer.wantsVoiceOnly) return; // don't send video to peers who asked not to receive it
      if (peer.videoSender) peer.videoSender.replaceTrack(newTrack);
    });
  }

  // ── Control panel ─────────────────────────────────────────────────────────
  function updateCtrlUI() {
    btnMic.querySelector('.ci').textContent  = audioMuted ? '🔇' : '🎤';
    btnMic.querySelector('.cl').textContent  = audioMuted ? 'Unmute' : 'Mute';
    btnMic.classList.toggle('off', audioMuted);
    btnCam.querySelector('.ci').textContent  = videoOff ? '📵' : '📷';
    btnCam.querySelector('.cl').textContent  = videoOff ? 'Cam off' : 'Camera';
    btnCam.classList.toggle('off', videoOff);
    btnVoice.querySelector('.ci').textContent = voiceOnly ? '🔇' : '🎙️';
    btnVoice.querySelector('.cl').textContent = 'Voice only';
    btnVoice.classList.toggle('active', voiceOnly);
    btnShare.querySelector('.ci').textContent = screenStream ? '⏹️' : '🖥️';
    btnShare.querySelector('.cl').textContent = screenStream ? 'Stop' : 'Share';
  }

  function toggleMute() {
    audioMuted = !audioMuted;
    localStream?.getAudioTracks().forEach(t => t.enabled = !audioMuted);
    updateCtrlUI();
  }
  function toggleCamera() {
    if (voiceOnly) {
      // Tapping camera while voice-only → exit voice-only and turn camera on
      voiceOnly = false;
      voiceOnlyPreCam = false;
      videoOff = false;
      localStream?.getVideoTracks().forEach(t => t.enabled = true);
      socket.emit('voice-only-off');
      socket.emit('camera-state', { videoOff: false });
      Object.values(peers).forEach(p => {
        if (p.wantsVoiceOnly || !p.videoSender) return;
        const track = localStream?.getVideoTracks()[0];
        if (track) p.videoSender.replaceTrack(track);
      });
      voiceOverlay.classList.add('hidden');
      layoutRemoteVideos();
      updateCtrlUI();
      return;
    }
    videoOff = !videoOff;
    localStream?.getVideoTracks().forEach(t => t.enabled = !videoOff);
    socket.emit('camera-state', { videoOff });
    updateCtrlUI();
  }

  function toggleVoiceOnly() {
    voiceOnly = !voiceOnly;
    if (voiceOnly) {
      voiceOnlyPreCam = !videoOff; // remember if camera was on
      if (!videoOff) {
        videoOff = true;
        localStream?.getVideoTracks().forEach(t => t.enabled = false);
        socket.emit('camera-state', { videoOff: true });
      }
      socket.emit('voice-only');
    } else {
      socket.emit('voice-only-off');
      // Restore camera to what it was before
      if (voiceOnlyPreCam) {
        videoOff = false;
        localStream?.getVideoTracks().forEach(t => t.enabled = true);
        socket.emit('camera-state', { videoOff: false });
        Object.values(peers).forEach(p => {
          if (p.wantsVoiceOnly || !p.videoSender) return;
          const track = localStream?.getVideoTracks()[0];
          if (track) p.videoSender.replaceTrack(track);
        });
      }
    }
    voiceOverlay.classList.toggle('hidden', !voiceOnly);
    if (voiceOnly) ctrlPanel.classList.add('hidden'); // close popup when entering voice-only
    layoutRemoteVideos();
    updateCtrlUI();
  }

  btnMic.addEventListener('click',   () => { toggleMute();        });
  btnCam.addEventListener('click',   () => { toggleCamera();      });
  btnVoice.addEventListener('click', () => { toggleVoiceOnly();   });
  btnShare.addEventListener('click', () => { toggleScreenShare(); });

  // Double-tap on background → open/close panel; single tap or vid-panel tap → ignore
  let tapCount = 0, tapTimer = null;
  let pressX = 0, pressY = 0, pressTime = 0;

  document.addEventListener('contextmenu', e => e.preventDefault());

  document.addEventListener('pointerdown', (e) => {
    // Tapping outside panel while it's open → close it
    if (!ctrlPanel.classList.contains('hidden') && !e.target.closest('#ctrl-panel')) {
      ctrlPanel.classList.add('hidden');
      return;
    }
    if (e.target.closest('.vid-panel') || e.target.closest('#ctrl-panel')) return;
    pressX = e.clientX; pressY = e.clientY; pressTime = Date.now();
  });

  document.addEventListener('pointerup', (e) => {
    if (e.target.closest('.vid-panel') || e.target.closest('#ctrl-panel')) return;
    if (!ctrlPanel.classList.contains('hidden')) return; // already handled by pointerdown
    const dx = e.clientX - pressX, dy = e.clientY - pressY;
    if (dx * dx + dy * dy > 64 || Date.now() - pressTime > 400) return;
    tapCount++;
    clearTimeout(tapTimer);
    if (tapCount >= 2) {
      tapCount = 0;
      updateCtrlUI();
      ctrlPanel.classList.remove('hidden');
      // Position near tap point, flip if too close to an edge
      const pw = ctrlPanel.offsetWidth, ph = ctrlPanel.offsetHeight, mg = 12;
      let x = e.clientX - pw / 2;
      let y = e.clientY + 16;
      // flip above if too close to bottom
      if (y + ph > window.innerHeight - mg) y = e.clientY - ph - 16;
      // clamp horizontally
      x = Math.max(mg, Math.min(window.innerWidth - pw - mg, x));
      // clamp vertically
      y = Math.max(mg, Math.min(window.innerHeight - ph - mg, y));
      Object.assign(ctrlPanel.style, { left: x+'px', top: y+'px' });
    } else {
      tapTimer = setTimeout(() => { tapCount = 0; }, 350);
    }
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', async () => {
    fitLocalPanel();
    makeInteractive(localPanel);
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
