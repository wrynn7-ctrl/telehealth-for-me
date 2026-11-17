'use strict';
// Shared by the client page and the provider page.
//
// Call      - the WebRTC connections. Every person connects directly to every
//             other person (a "mesh"); audio and video are encrypted between
//             browsers and never pass through the server.
// CallView  - draws the video tiles, the shared screen and the buttons.

class Call {
  constructor({ send, onChange }) {
    this.send = send; // (message) => void, sends over the websocket
    this.onChange = onChange || (() => {});
    this.peers = new Map();
    this.local = null; // camera + microphone stream
    this.screenTrack = null;
    this.iceServers = [];
    this.state = { audio: false, video: false, screen: false };
  }

  setIce(ice) {
    const servers = [];
    if (ice && ice.stunPort) servers.push({ urls: `stun:${location.hostname}:${ice.stunPort}` });
    if (ice && ice.turn) servers.push(ice.turn);
    this.iceServers = servers;
  }

  // Asks for the camera and microphone. Falls back to microphone only, and
  // finally to listen-only, so a missing camera never blocks a visit.
  async startMedia() {
    if (this.local) return this.local;
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const video = { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' };
    try {
      this.local = await navigator.mediaDevices.getUserMedia({ audio, video });
    } catch {
      try {
        this.local = await navigator.mediaDevices.getUserMedia({ audio });
      } catch {
        this.local = new MediaStream();
      }
    }
    this.state.audio = this.local.getAudioTracks().length > 0;
    this.state.video = this.local.getVideoTracks().length > 0;
    return this.local;
  }

  track(kind) {
    if (!this.local) return null;
    return (kind === 'audio' ? this.local.getAudioTracks() : this.local.getVideoTracks())[0] || null;
  }

  announce() {
    this.send({ t: 'state', ...this.state });
    this.onChange();
  }

  setMic(on) {
    const track = this.track('audio');
    if (!track) return;
    track.enabled = on;
    this.state.audio = on;
    this.announce();
  }

  setCamera(on) {
    const track = this.track('video');
    if (!track) return;
    track.enabled = on;
    this.state.video = on;
    this.announce();
  }

  async startScreen() {
    if (this.screenTrack) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
    } catch {
      return; // the person closed the browser's picker
    }
    this.screenTrack = stream.getVideoTracks()[0];
    this.screenTrack.contentHint = 'detail';
    this.screenTrack.addEventListener('ended', () => this.stopScreen());
    for (const peer of this.peers.values()) peer.senders.screen.replaceTrack(this.screenTrack).catch(() => {});
    this.state.screen = true;
    this.announce();
  }

  stopScreen() {
    if (!this.screenTrack) return;
    this.screenTrack.stop();
    this.screenTrack = null;
    for (const peer of this.peers.values()) peer.senders.screen.replaceTrack(null).catch(() => {});
    this.state.screen = false;
    this.announce();
  }

  // Each connection carries three fixed lanes: microphone, camera, screen.
  // The screen lane stays empty until someone shares, so starting a screen
  // share never has to renegotiate the connection.
  addPeer(info, initiator) {
    this.removePeer(info.id);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = {
      id: info.id,
      name: info.name,
      role: info.role,
      state: info.state || { audio: true, video: true, screen: false },
      pc,
      initiator,
      pendingIce: [],
      senders: null,
      media: new MediaStream(),
      screen: new MediaStream(),
      connected: false,
    };
    this.peers.set(peer.id, peer);

    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) this.send({ t: 'signal', to: peer.id, data: { ice: event.candidate } });
    });
    pc.addEventListener('connectionstatechange', () => {
      peer.connected = pc.connectionState === 'connected';
      if (pc.connectionState === 'failed') {
        if (initiator) pc.restartIce();
        else this.send({ t: 'signal', to: peer.id, data: { restart: true } });
      }
      this.onChange();
    });

    if (initiator) {
      const lanes = [
        pc.addTransceiver(this.track('audio') || 'audio', { direction: 'sendrecv' }),
        pc.addTransceiver(this.track('video') || 'video', { direction: 'sendrecv' }),
        pc.addTransceiver(this.screenTrack || 'video', { direction: 'sendrecv' }),
      ];
      this.adoptLanes(peer, lanes);
      pc.addEventListener('negotiationneeded', () => this.offer(peer));
    }
    this.onChange();
    return peer;
  }

  adoptLanes(peer, lanes) {
    peer.senders = { audio: lanes[0].sender, video: lanes[1].sender, screen: lanes[2].sender };
    peer.media.addTrack(lanes[0].receiver.track);
    peer.media.addTrack(lanes[1].receiver.track);
    peer.screen.addTrack(lanes[2].receiver.track);
  }

  async offer(peer) {
    if (peer.offering || peer.pc.signalingState !== 'stable') return;
    peer.offering = true;
    try {
      await peer.pc.setLocalDescription();
      this.send({ t: 'signal', to: peer.id, data: { sdp: peer.pc.localDescription } });
    } catch (err) {
      console.error('Could not start connection', err);
    } finally {
      peer.offering = false;
    }
  }

  async handleSignal(from, data) {
    const peer = this.peers.get(from);
    if (!peer) return;
    const pc = peer.pc;
    try {
      if (data.sdp) {
        if (data.sdp.type === 'offer' && peer.initiator) return;
        if (data.sdp.type === 'answer' && !peer.initiator) return;
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          if (!peer.senders) {
            const lanes = pc.getTransceivers();
            if (lanes.length !== 3) throw new Error('unexpected connection layout');
            const tracks = [this.track('audio'), this.track('video'), this.screenTrack];
            for (let i = 0; i < 3; i++) {
              lanes[i].direction = 'sendrecv';
              if (tracks[i]) await lanes[i].sender.replaceTrack(tracks[i]);
            }
            this.adoptLanes(peer, lanes);
          }
          await pc.setLocalDescription();
          this.send({ t: 'signal', to: peer.id, data: { sdp: pc.localDescription } });
        }
        for (const candidate of peer.pendingIce.splice(0)) await pc.addIceCandidate(candidate);
        this.onChange();
      } else if (data.ice) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.ice);
        else peer.pendingIce.push(data.ice);
      } else if (data.restart && peer.initiator) {
        pc.restartIce();
      }
    } catch (err) {
      console.error('Connection problem', err);
    }
  }

  setPeerState(id, state) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.state = state;
    this.onChange();
  }

  removePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.close();
    this.peers.delete(id);
    this.onChange();
  }

  // Hangs up on everyone but keeps the camera running (used between visits).
  hangUpAll() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }

  // Hangs up and switches the camera, microphone and screen share off.
  close() {
    this.hangUpAll();
    if (this.screenTrack) this.screenTrack.stop();
    this.screenTrack = null;
    if (this.local) for (const track of this.local.getTracks()) track.stop();
    this.local = null;
    this.state = { audio: false, video: false, screen: false };
  }
}

class CallView {
  // root must contain the markup from call section of the page:
  // [data-stage], [data-stage-video], [data-stage-label], [data-tiles],
  // [data-mic], [data-camera], [data-share], [data-sound]
  constructor(root, call, { selfName }) {
    this.root = root;
    this.call = call;
    this.selfName = selfName;
    this.tiles = new Map();
    this.q = (name) => root.querySelector(`[data-${name}]`);

    this.q('mic').addEventListener('click', () => call.setMic(!call.state.audio));
    this.q('camera').addEventListener('click', () => call.setCamera(!call.state.video));
    const share = this.q('share');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) share.hidden = true;
    share.addEventListener('click', () => (call.state.screen ? call.stopScreen() : call.startScreen()));
    this.q('sound').addEventListener('click', () => {
      this.q('sound').hidden = true;
      for (const video of root.querySelectorAll('video')) video.play().catch(() => {});
    });
  }

  makeTile(id, name, isSelf) {
    const tile = document.createElement('div');
    tile.className = 'tile' + (isSelf ? ' tile-self' : '');
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isSelf;
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = (name.trim()[0] || '?').toUpperCase();
    const label = document.createElement('div');
    label.className = 'tile-label';
    const status = document.createElement('div');
    status.className = 'tile-status';
    tile.append(video, avatar, label, status);
    this.q('tiles').append(tile);
    const entry = { tile, video, avatar, label, status };
    this.tiles.set(id, entry);
    return entry;
  }

  play(video) {
    const attempt = video.play();
    if (attempt) attempt.catch((err) => {
      // The browser blocked sound until the person clicks something.
      if (err.name === 'NotAllowedError' && !video.muted) this.q('sound').hidden = false;
    });
  }

  render() {
    const call = this.call;
    const wanted = new Set(['self', ...call.peers.keys()]);
    for (const [id, entry] of this.tiles) {
      if (!wanted.has(id)) {
        entry.tile.remove();
        this.tiles.delete(id);
      }
    }

    // Own picture.
    const self = this.tiles.get('self') || this.makeTile('self', this.selfName, true);
    if (call.local && self.video.srcObject !== call.local) {
      self.video.srcObject = call.local;
      this.play(self.video);
    }
    self.label.textContent = `${this.selfName} (you)`;
    self.tile.classList.toggle('no-video', !call.state.video);
    self.status.textContent = call.state.audio ? '' : 'Muted';

    // Everyone else.
    let sharer = null;
    for (const peer of call.peers.values()) {
      const entry = this.tiles.get(peer.id) || this.makeTile(peer.id, peer.name, false);
      if (entry.video.srcObject !== peer.media) {
        entry.video.srcObject = peer.media;
        this.play(entry.video);
      }
      entry.label.textContent = peer.name;
      entry.tile.classList.toggle('no-video', !peer.state.video);
      entry.status.textContent = !peer.connected ? 'Connecting…' : peer.state.audio ? '' : 'Muted';
      if (peer.state.screen && !sharer) sharer = peer;
    }

    // Shared screen, shown large above the tiles.
    const stage = this.q('stage');
    const stageVideo = this.q('stage-video');
    const stageLabel = this.q('stage-label');
    if (sharer) {
      if (stageVideo.srcObject !== sharer.screen) {
        stageVideo.srcObject = sharer.screen;
        this.play(stageVideo);
      }
      stageVideo.hidden = false;
      stageLabel.textContent = `${sharer.name} is sharing their screen`;
    } else {
      stageVideo.srcObject = null;
      stageVideo.hidden = true;
      stageLabel.textContent = call.state.screen ? 'You are sharing your screen' : '';
    }
    stage.hidden = !sharer && !call.state.screen;
    this.root.classList.toggle('has-stage', !stage.hidden);
    this.q('tiles').dataset.count = String(this.tiles.size);

    // Buttons.
    const mic = this.q('mic');
    mic.disabled = !call.track('audio');
    mic.textContent = call.state.audio ? 'Mute' : 'Unmute';
    mic.classList.toggle('off', !call.state.audio);
    mic.setAttribute('aria-pressed', String(!call.state.audio));
    const camera = this.q('camera');
    camera.disabled = !call.track('video');
    camera.textContent = call.state.video ? 'Stop camera' : 'Start camera';
    camera.classList.toggle('off', !call.state.video);
    camera.setAttribute('aria-pressed', String(!call.state.video));
    const share = this.q('share');
    share.textContent = call.state.screen ? 'Stop sharing' : 'Share screen';
    share.classList.toggle('on', call.state.screen);
  }
}

// Opens the websocket to the server on the same address as the page.
function openSocket(query) {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${scheme}//${location.host}/ws${query || ''}`);
}

window.Telehealth = { Call, CallView, openSocket };
