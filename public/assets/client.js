'use strict';
(() => {
  const { Call, CallView, openSocket } = window.Telehealth;
  const $ = (id) => document.getElementById(id);
  const screens = ['join', 'waiting', 'call', 'done'];
  let socket = null;
  let call = null;
  let view = null;
  let finished = false;

  function show(name) {
    for (const id of screens) $(id).hidden = id !== name;
    document.body.classList.toggle('in-call', name === 'call');
  }

  function finish(title, text) {
    if (finished) return;
    finished = true;
    if (call) call.close();
    if (socket) socket.close();
    $('preview').srcObject = null;
    $('doneTitle').textContent = title;
    $('doneText').textContent = text;
    show('done');
  }

  function supported() {
    return window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  }

  $('joinForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('name').value.trim();
    if (!name) return;
    if (!supported()) {
      $('joinError').textContent = 'This browser cannot do video visits. Please use a current version of Chrome, Edge, Firefox or Safari.';
      $('joinError').hidden = false;
      return;
    }
    $('joinForm').querySelector('button').disabled = true;
    finished = false;

    call = new Call({
      send: (message) => socket && socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message)),
      onChange: () => view && view.render(),
    });
    const stream = await call.startMedia();
    $('preview').srcObject = stream;
    $('previewNote').textContent = call.state.video
      ? 'This is how you will appear.'
      : call.state.audio
        ? 'No camera found. You will join with sound only.'
        : 'No camera or microphone available. You will be able to watch and listen only.';

    socket = openSocket();
    socket.addEventListener('open', () => socket.send(JSON.stringify({ t: 'knock', name })));
    socket.addEventListener('message', (event) => onMessage(JSON.parse(event.data), name));
    socket.addEventListener('close', () => finish('You were disconnected', 'The connection was lost. Return to the start to rejoin the waiting room.'));
  });

  function onMessage(message, name) {
    switch (message.t) {
      case 'waiting':
        show('waiting');
        break;
      case 'error':
        finish('Unable to join', message.text);
        break;
      case 'admitted':
        call.setIce(message.ice);
        view = new CallView($('call'), call, { selfName: name });
        $('preview').srcObject = null;
        show('call');
        for (const peer of message.peers) call.addPeer(peer, true);
        call.announce();
        break;
      case 'peer-joined':
        call.addPeer(message.peer, false);
        break;
      case 'peer-left':
        call.removePeer(message.id);
        break;
      case 'signal':
        call.handleSignal(message.from, message.data);
        break;
      case 'state':
        call.setPeerState(message.id, message.state);
        break;
      case 'denied':
        finish('Not admitted', 'Your provider was not able to bring you in. Please contact them directly.');
        break;
      case 'removed':
      case 'ended':
        finish('Your visit has ended', 'Thank you. You can close this page.');
        break;
      default:
    }
  }

  $('leaveWaiting').addEventListener('click', () => finish('You left the waiting room', 'You can close this page.'));
  $('leaveCall').addEventListener('click', () => finish('You left the visit', 'You can close this page.'));
  $('again').addEventListener('click', () => location.reload());
})();
