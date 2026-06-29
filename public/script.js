(() => {
  const FIXED_ROOM = 'main';

  const STUN_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  const localVideo  = document.getElementById('local-video');
  const remoteVideo = document.getElementById('remote-video');
  const waitingMsg  = document.getElementById('waiting-msg');
  const muteBtn     = document.getElementById('mute-btn');
  const cameraBtn   = document.getElementById('camera-btn');
  const leaveBtn    = document.getElementById('leave-btn');
  const toast       = document.getElementById('toast');

  let localStream = null;
  let pc = null;
  let audioMuted = false;
  let videoOff = false;
  const socket = io();

  function showToast(msg, duration = 3500) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.add('hidden'), duration);
  }

  function setButtonActive(btn, active, offLabel, onLabel) {
    btn.classList.toggle('off', active);
    btn.querySelector('span').textContent = active ? onLabel : offLabel;
  }

  async function getLocalMedia() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
    } catch (err) {
      showToast('Camera/mic access denied. Please allow permissions and reload.');
      console.error('getUserMedia error:', err);
    }
  }

  function createPeerConnection() {
    pc = new RTCPeerConnection(STUN_SERVERS);

    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    pc.ontrack = (event) => {
      remoteVideo.srcObject = event.streams[0];
      waitingMsg.style.display = 'none';
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', { roomId: FIXED_ROOM, candidate: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        showToast('The other person left.');
        waitingMsg.style.display = 'flex';
        remoteVideo.srcObject = null;
      }
    };
  }

  // Auto-join on load
  window.addEventListener('DOMContentLoaded', async () => {
    await getLocalMedia();
    if (!localStream) return;
    socket.emit('join-room', FIXED_ROOM);
  });

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
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('ICE candidate error:', e);
    }
  });

  socket.on('peer-left', () => {
    showToast('The other person left.');
    waitingMsg.style.display = 'flex';
    remoteVideo.srcObject = null;
    if (pc) { pc.close(); pc = null; }
  });

  socket.on('room-full', () => {
    showToast('Room is busy — only 2 people allowed at a time.');
  });

  muteBtn.addEventListener('click', () => {
    audioMuted = !audioMuted;
    localStream.getAudioTracks().forEach((t) => (t.enabled = !audioMuted));
    setButtonActive(muteBtn, audioMuted, 'Mute', 'Unmute');
  });

  cameraBtn.addEventListener('click', () => {
    videoOff = !videoOff;
    localStream.getVideoTracks().forEach((t) => (t.enabled = !videoOff));
    setButtonActive(cameraBtn, videoOff, 'Camera', 'Start Cam');
  });

  leaveBtn.addEventListener('click', () => {
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    if (pc) { pc.close(); pc = null; }
    socket.disconnect();
    location.reload();
  });
})();
