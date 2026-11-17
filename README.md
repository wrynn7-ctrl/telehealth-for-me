# Telehealth for Me

A private video-visit app that runs in the browser and is hosted on your own Windows computer.

- **Clients** open one link, type their name and land in a waiting room. They see nobody and nobody sees them, except you.
- **You** sign in at `/provider`, see who is waiting, and admit (or turn away) each person.
- Sessions can be one-on-one or a small group (up to 8 people including you).
- Anyone in the session can share their screen.
- Audio, video and screen sharing travel encrypted directly between the browsers. They do not pass through the server, and nothing is recorded or stored.

## What "HIPAA compliant" means here

No software is HIPAA compliant on its own. Compliance depends on how you run it, and it is your responsibility as the covered entity. This app supplies the technical safeguards; the checklist below covers the parts only you can do.

**What the app does**

| Safeguard | How |
| --- | --- |
| Encryption in transit | HTTPS for every page; audio/video encrypted browser-to-browser (WebRTC DTLS-SRTP) |
| Access control | Password-protected provider page; clients can do nothing until you admit them |
| Automatic logoff | Sign-in ends after 15 idle minutes, and after 12 hours regardless |
| Sign-in protection | Password stored only as a salted scrypt hash; lockout after 5 wrong attempts in 15 minutes |
| Audit log | `data/audit.log` records sign-ins, failed sign-ins, admissions, removals and session ends |
| Minimum data | No client accounts, no recordings, no chat history. Client names live in memory only while they are connected and are never written to disk, including the audit log |
| No third parties | No analytics, no outside scripts or fonts, and a built-in STUN server so no outside company is involved in connecting calls |

**What you must do**

- [ ] Turn on BitLocker (full-disk encryption) on the host computer and use a strong Windows password with screen lock.
- [ ] Keep Windows, Node.js and Caddy up to date.
- [ ] Use a long, unique provider password that you use nowhere else.
- [ ] Keep the computer physically secure, and review `data/audit.log` periodically.
- [ ] Complete your own HIPAA risk analysis and document this system in it.
- [ ] Get client consent for telehealth as your licensing board and state require.
- [ ] If you add any outside service that touches visit traffic (a tunnel, a hosted TURN relay), sign a Business Associate Agreement with it first.

## Setup on Windows

You need a domain name (about $12/year) and access to your router's settings.

### 1. Install the software

1. Install **Node.js LTS** from <https://nodejs.org>.
2. Download **Caddy** for Windows from <https://caddyserver.com/download> and put `caddy.exe` in this folder.
3. Double-click **`start.bat`**. The first time, it installs one dependency and asks you to choose your provider password (at least 12 characters) and the name clients will see for you.

To change the password later, open a terminal in this folder and run `npm run setup`, then restart `start.bat`.

### 2. Point your domain at your computer

1. At your domain registrar, create an **A record** (for example `visits.yourdomain.com`) pointing to your home or office public IP address. If your internet provider changes your IP from time to time, use your registrar's or router's Dynamic DNS feature to keep it current.
2. In your router, forward these ports to the host computer:
   - **TCP 80** and **TCP 443** (the web pages; port 80 is needed to issue the HTTPS certificate)
   - **UDP 3478** (helps browsers find a direct route to each other)
3. Allow the same three ports through Windows Defender Firewall (Windows usually prompts the first time each program runs; choose "Allow").

### 3. Turn on HTTPS

1. Open `Caddyfile` in Notepad and replace `visits.example.com` with your domain.
2. Open a terminal in this folder and run `caddy run`. Leave it open. Caddy obtains the HTTPS certificate on its own.

### 4. Use it

- Your page: `https://visits.yourdomain.com/provider`
- Your clients' link: `https://visits.yourdomain.com/`

Both `start.bat` and `caddy run` must be running, and the computer must be awake (set Windows to never sleep while plugged in), whenever you see clients.

## A typical visit

1. Sign in at `/provider` and allow the camera and microphone.
2. When a client opens your link and enters their name, they appear under **Waiting room**. You hear a chime and the browser tab shows the count.
3. Click **Admit**. Admit more people for a group session.
4. Use **Share screen** as needed. Clients can share too.
5. Click **End session for everyone** when done, then **Sign out** at the end of the day.

If you refresh the page or briefly lose your connection, clients stay in the session for one minute while you reconnect.

## Good to know

- **Some networks block direct connections.** On a small share of networks (strict corporate or hospital Wi-Fi, some mobile carriers) two browsers cannot reach each other directly and the video stays on "Connecting…". The fix is a TURN relay. If this happens with your clients, run [coturn](https://github.com/coturn/coturn) and add it to `data/config.json`:
  ```json
  "turn": { "urls": ["turn:visits.yourdomain.com:3478"], "secret": "your-coturn-static-auth-secret" }
  ```
  Relayed media stays encrypted end to end; the relay cannot see or hear it.
- **Group size.** Each person sends their video to every other person, so groups above about 6 need good upload speeds all round.
- **Phones.** Clients can join from a phone browser. Screen sharing is not available on most phone browsers, so the button is hidden there.
- **Testing on the host computer itself.** `http://localhost:3000/` works without Caddy for a quick check.

## Settings

Stored in `data/config.json` (created by setup). Restart the server after editing.

| Setting | Default | Meaning |
| --- | --- | --- |
| `port` | `3000` | Local port Caddy forwards to |
| `host` | `127.0.0.1` | Keep this so the unencrypted port is never reachable from outside |
| `stunPort` | `3478` | Built-in STUN server; `0` turns it off |
| `turn` | `null` | Optional TURN relay (see above) |
| `providerName` | `Provider` | Name clients see for you |
| `idleMinutes` | `15` | Idle time before sign-in ends |
| `maxSessionHours` | `12` | Longest a sign-in can last |

## How it is put together

```
server/server.js   web pages, sign-in, waiting room, call setup messages
server/stun.js     tiny built-in STUN server
server/setup.js    sets the provider password
public/            the pages clients and the provider see
data/              your config and audit log (created on first run, never committed)
```
