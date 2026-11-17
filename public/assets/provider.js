'use strict';
(() => {
  const { Call, CallView, openSocket } = window.Telehealth;
  const $ = (id) => document.getElementById(id);
  const IDLE_SIGN_OUT_MS = 15 * 60 * 1000;
  const BASE_TITLE = document.title;

  let socket = null;
  let view = null;
  let waiting = [];
  let knownWaiting = new Set();
  let reconnects = 0;
  let stopped = false;
  let lastActivity = Date.now();
  let lastSignature = '';

  const send = (message) => socket && socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));
  const call = new Call({ send, onChange: () => render() });

  // ------------------------------------------------------------- rendering
  function personRow(name, detail, buttons) {
    const item = document.createElement('li');
    const text = document.createElement('div');
    text.className = 'person';
    const strong = document.createElement('strong');
    strong.textContent = name;
    const small = document.createElement('span');
    small.textContent = detail;
    text.append(strong, small);
    const actions = document.createElement('div');
    actions.className = 'person-actions';
    for (const [label, className, onClick] of buttons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.className = className;
      button.setAttribute('aria-label', `${label} ${name}`);
      button.addEventListener('click', onClick);
      actions.append(button);
    }
    item.append(text, actions);
    return item;
  }

  function waitedFor(since) {
    const minutes = Math.floor((Date.now() - since) / 60000);
    return minutes < 1 ? 'Just arrived' : `Waiting ${minutes} min`;
  }

  function render() {
    if (view) view.render();

    // Only rebuild the lists when their content changed, so a button is never
    // swapped out from under a click.
    const signature = JSON.stringify([
      waiting.map((person) => [person.id, waitedFor(person.since)]),
      [...call.peers.values()].map((peer) => [peer.id, peer.connected]),
    ]);
    if (signature === lastSignature) return;
    lastSignature = signature;

    $('waitingList').replaceChildren(
      ...waiting.map((person) =>
        personRow(person.name, waitedFor(person.since), [
          ['Admit', 'primary', () => send({ t: 'admit', id: person.id })],
          ['Turn away', '', () => confirm(`Turn ${person.name} away?`) && send({ t: 'deny', id: person.id })],
        ]),
      ),
    );
    $('waitingEmpty').hidden = waiting.length > 0;
    $('waitingCount').hidden = waiting.length === 0;
    $('waitingCount').textContent = String(waiting.length);
    document.title = waiting.length ? `(${waiting.length} waiting) ${BASE_TITLE}` : BASE_TITLE;

    const members = [...call.peers.values()];
    $('memberList').replaceChildren(
      ...members.map((peer) =>
        personRow(peer.name, peer.connected ? 'Connected' : 'Connecting…', [
          ['Remove', '', () => confirm(`Remove ${peer.name} from the session?`) && send({ t: 'remove', id: peer.id })],
        ]),
      ),
    );
    $('membersEmpty').hidden = members.length > 0;
    $('endSession').hidden = members.length === 0;
  }

  function chime() {
    try {
      const audio = new AudioContext();
      const tone = audio.createOscillator();
      const volume = audio.createGain();
      tone.frequency.value = 660;
      volume.gain.setValueAtTime(0.15, audio.currentTime);
      volume.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.6);
      tone.connect(volume).connect(audio.destination);
      tone.start();
      tone.stop(audio.currentTime + 0.6);
      tone.addEventListener('ended', () => audio.close());
    } catch {
      /* sound is a nicety; the list and tab title still update */
    }
  }

  function overlay(title, text, buttonLabel) {
    stopped = true;
    call.close();
    $('overlayTitle').textContent = title;
    $('overlayText').textContent = text;
    $('overlayButton').textContent = buttonLabel;
    $('overlay').hidden = false;
  }

  // ------------------------------------------------------------- messages
  function onMessage(message) {
    switch (message.t) {
      case 'hello':
        reconnects = 0;
        call.setIce(message.ice);
        if (!view) view = new CallView($('call'), call, { selfName: message.name });
        for (const peer of message.peers) call.addPeer(peer, true);
        call.announce();
        break;
      case 'waiting-list': {
        const arrivals = message.list.filter((person) => !knownWaiting.has(person.id));
        waiting = message.list;
        knownWaiting = new Set(waiting.map((person) => person.id));
        if (arrivals.length) chime();
        render();
        break;
      }
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
      case 'notice':
        $('notice').textContent = message.text;
        break;
      default:
    }
  }

  function connect() {
    socket = openSocket('?role=provider');
    socket.addEventListener('message', (event) => onMessage(JSON.parse(event.data)));
    socket.addEventListener('close', (event) => {
      if (stopped) return;
      call.hangUpAll();
      waiting = [];
      render();
      if (event.code === 4001) {
        return overlay('Opened in another window', 'The provider page was opened somewhere else, so this one was disconnected.', 'Use this window instead');
      }
      // Signed out, or sign-in no longer valid: the reload shows the sign-in page.
      if (event.code === 4003 || ++reconnects > 5) return location.reload();
      $('notice').textContent = 'Connection lost. Reconnecting…';
      setTimeout(connect, 2000);
    });
    socket.addEventListener('open', () => ($('notice').textContent = ''));
  }

  // -------------------------------------------------------------- buttons
  async function signOut() {
    stopped = true;
    call.close();
    try {
      await fetch('/api/logout', { method: 'POST' });
    } finally {
      location.reload();
    }
  }

  $('signOut').addEventListener('click', signOut);
  $('endSession').addEventListener('click', () => confirm('End the session for everyone?') && send({ t: 'end' }));
  $('overlayButton').addEventListener('click', () => location.reload());
  $('clientLink').value = `${location.origin}/`;
  $('copyLink').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('clientLink').value);
      $('notice').textContent = 'Link copied.';
    } catch {
      $('clientLink').select();
    }
  });

  // Sign out automatically when the page sits unused with nobody in session
  // and nobody waiting.
  for (const type of ['pointerdown', 'keydown', 'pointermove']) {
    window.addEventListener(type, () => (lastActivity = Date.now()), { passive: true });
  }
  setInterval(() => {
    if (stopped) return;
    if (call.peers.size || waiting.length) lastActivity = Date.now();
    else if (Date.now() - lastActivity > IDLE_SIGN_OUT_MS) signOut();
    render(); // refreshes the "Waiting 3 min" text
  }, 30 * 1000);

  // ---------------------------------------------------------------- start
  call.startMedia().then(() => {
    render();
    connect();
  });
})();
