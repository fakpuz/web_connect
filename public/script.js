(() => {
  const FIXED_ROOM = 'main';
  const STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

  const localVideo   = document.getElementById('local-video');
  const localWrapper = document.getElementById('local-wrapper');
  const waitingMsg   = document.getElementById('waiting-msg');
  const gestureIcon  = document.getElementById('gesture-icon');
  const toast        = document.getElementById('toast');

  let localStream = null;
  let audioMuted  = false;
  let videoOff    = false;
  const socket    = io();
  const peers     = {}; // peerId -> { pc, cell, video }

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

  // ── Drag — shared for both local and remote ───────────────────────────────
  // containFully=true  → element must stay completely within screen (remote videos)
  // containFully=false → element can go partially off-screen (self-view)
  function makeDraggable(el, containFully) {
    let dragging = false, didDrag = false, ox = 0, oy = 0;

    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      didDrag  = false;
      el.setPointerCapture(e.pointerId);
      const r = el.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      e.stopPropagation();
    });

    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      didDrag = true;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let x = e.clientX - ox;
      let y = e.clientY - oy;

      if (containFully) {
        // Stay fully inside screen
        x = Math.max(0, Math.min(window.innerWidth  - w, x));
        y = Math.max(0, Math.min(window.innerHeight - h, y));
      } else {
        // Allow going mostly off-screen but keep 40px visible
        const B = 40;
        x = Math.max(B - w, Math.min(window.innerWidth  - B, x));
        y = Math.max(B - h, Math.min(window.innerHeight - B, y));
      }

      el.style.left   = x + 'px';
      el.style.top    = y + 'px';
      el.style.right  = 'auto';
      el.style.bottom = 'auto';
    });

    el.addEventListener('click', (e) => {
      if (didDrag) { didDrag = false; e.stopPropagation(); }
    });

    el.addEventListener('pointerup',    () => { dragging = false; });
    el.addEventListener('pointercancel',() => { dragging = false; });
  }

  // ── Layout: compute grid positions for N remote videos ────────────────────
  function gridPositions(n) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (n === 1) return [{ x:0,   y:0,   w:W,   h:H   }];
    if (n === 2) return [{ x:0,   y:0,   w:W/2, h:H   },
                         { x:W/2, y:0,   w:W/2, h:H   }];
    if (n === 3) return [{ x:0,   y:0,   w:W/2, h:H/2 },
                         { x:W/2, y:0,   w:W/2, h:H/2 },
                         { x:0,   y:H/2, w:W,   h:H/2 }];
    return           [{ x:0,   y:0,   w:W/2, h:H/2 },
                      { x:W/2, y:0,   w:W/2, h:H/2 },
                      { x:0,   y:H/2, w:W/2, h:H/2 },
                      { x:W/2, y:H/2, w:W/2, h:H/2 }];
  }

  function layoutRemoteVideos() {
    const cells = Object.values(peers).map(p => p.cell).filter(Boolean);
    const positions = gridPositions(cells.length);
    cells.forEach((cell, i) => {
      const p = positions[i];
      cell.style.left   = p.x + 'px';
      cell.style.top    = p.y + 'px';
      cell.style.width  = p.w + 'px';
      cell.style.height = p.h + 'px';
      cell.style.right  = 'auto';
      cell.style.bottom = 'auto';
    });
    waitingMsg.style.display = cells.length === 0 ? 'flex' : 'none';
  }

  window.addEventListener('resize', layoutRemoteVideos);

  // ── Remote video management ───────────────────────────────────────────────
  function addRemoteVideo(peerId) {
    if (peers[peerId]?.cell) return;
    const cell  = document.createElement('div');
    cell.className = 'remote-cell';
    const video = document.createElement('video');
    video.autoplay   = true;
    video.playsInline = true;
    cell.appendChild(video);
    document.getElementById('app').appendChild(cell);
    if (!peers[peerId]) peers[peerId] = {};
    peers[peerId].cell  = cell;
    peers[peerId].video = video;
    makeDraggable(cell, true); // fully contained
    layoutRemoteVideos();
  }

  function removeRemoteVideo(peerId) {
    peers[peerId]?.cell?.remove();
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
      const video = peers[peerId]?.video || (() => { addRemoteVideo(peerId); return peers[peerId].video; })();
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
  socket.on('existing-peers', async (peerIds) => {
    for (const peerId of peerIds) {
      addRemoteVideo(peerId);
      const pc    = createPC(peerId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: peerId, sdp: pc.localDescription });
    }
  });

  socket.on('peer-joined', (peerId) => addRemoteVideo(peerId));

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

  socket.on('peer-left',  (peerId) => { removeRemoteVideo(peerId); showToast('Someone left.'); });
  socket.on('room-full',  ()       => showToast('Room is full (max 4 people).'));

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
      if (!pc) return;
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) sender.replaceTrack(newTrack);
    });
  }

  // ── Gesture controls ──────────────────────────────────────────────────────
  function toggleMute()   {
    audioMuted = !audioMuted;
    localStream?.getAudioTracks().forEach(t => t.enabled = !audioMuted);
    showIcon(audioMuted ? '🔇' : '🎤');
  }
  function toggleCamera() {
    videoOff = !videoOff;
    localStream?.getVideoTracks().forEach(t => t.enabled = !videoOff);
    showIcon(videoOff ? '📵' : '📷');
  }

  let tapCount = 0, tapTimer = null, pressTimer = null, longPressed = false;

  document.addEventListener('contextmenu', e => e.preventDefault());

  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#local-wrapper') || e.target.closest('.remote-cell')) return;
    longPressed = false;
    pressTimer  = setTimeout(() => { longPressed = true; toggleScreenShare(); }, 600);
  });

  document.addEventListener('pointermove', (e) => {
    if (e.movementX ** 2 + e.movementY ** 2 > 100) clearTimeout(pressTimer);
  });

  document.addEventListener('pointerup',    () => clearTimeout(pressTimer));
  document.addEventListener('pointercancel',() => clearTimeout(pressTimer));

  document.addEventListener('click', (e) => {
    if (e.target.closest('#local-wrapper') || e.target.closest('.remote-cell')) return;
    if (longPressed) { longPressed = false; return; }
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
    const setVh = () => document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
    setVh();
    window.addEventListener('resize', setVh);

    makeDraggable(localWrapper, false); // self-view: can go partially off-screen

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
