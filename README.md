# RayCare OS

**Patient flow operating system for hospitals.** Live OPD queues with honest wait times, ESI emergency triage, bed management, appointments, lobby displays and multilingual patient updates, in one self-hosted system.

Built on research published at the ORCHIDS International Conference ([DOI 10.6084/m9.figshare.30545999](https://doi.org/10.6084/m9.figshare.30545999)).

| | |
|---|---|
| **Staff app** | Front desk, doctor console, emergency triage, beds, appointments, patient records, analytics, settings, audit log |
| **Lobby TV** | Name-free token board with spoken announcements in English, Hindi and Telugu |
| **Patient pages** | QR self check-in and a live tracking page, no app to install |
| **Backend** | Node.js + built-in SQLite, one dependency, realtime updates, role-based access, 26 automated tests |

---

## Install

You need **Node.js 22.5 or newer** or **Docker**. Nothing else: no database server, no build step.

### Option A: Docker (recommended for hospitals)

```bash
git clone https://github.com/RayeesaMahmood/RayCare.git
cd RayCare
docker compose up -d
```

Open **http://localhost:8080/app/**. The setup wizard walks you through the rest.

### Option B: Node.js on Linux or macOS

```bash
git clone https://github.com/RayeesaMahmood/RayCare.git
cd RayCare
./install.sh
npm start
```

### Option C: Windows (PowerShell)

```powershell
git clone https://github.com/RayeesaMahmood/RayCare.git
cd RayCare
.\install.ps1
npm start
```

### Try it first with a simulated hospital

```bash
npm install
npm run demo
```

Demo logins use the password `demo1234`: `admin@demo.local`, `desk@demo.local`, `doctor@demo.local`, `nurse@demo.local`. The demo database resets each time it starts.

---

## First-run setup (about three minutes)

1. **Your hospital:** name, city, whether patients may check in by QR.
2. **Departments:** tick from ten specialties and set rooms and doctors. Emergency is always included.
3. **Wards and languages:** bed counts for ICU, general and paediatric wards, and patient languages.
4. **Administrator account:** your name, email and password.

Then, from **Settings**:

- create accounts for desk staff, doctors and nurses (each role sees only its screens),
- open **/tv/** on the lobby TV's browser (double-click for full screen, tap to enable announcements),
- print the **QR check-in poster** for the entrance.

| Address | Who uses it |
|---|---|
| `/app/` | Staff (sign-in required) |
| `/tv/` | Lobby display |
| `/checkin/` | Patients, via the QR poster |
| `/t/?v=…&k=…` | A patient's private tracking link (sent by SMS and printed on the slip) |
| `/` | Product website (set `SERVE_WEBSITE=false` to open the staff app instead) |

---

## Configuration

Copy `.env.example` to `.env` (the installers do this). Every setting is optional.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Web server port |
| `PUBLIC_URL` | `http://localhost:8080` | Address used in patient SMS links |
| `DATA_DIR` | `./data` | Where the database file lives |
| `JWT_SECRET` | auto | Session signing secret; generated on first start if empty |
| `TOKEN_TTL_HOURS` | `12` | How long staff stay signed in |
| `NOTIFY_PROVIDER` | `console` | `console`, `webhook` or `none` |
| `NOTIFY_WEBHOOK_URL` | | Your SMS / WhatsApp gateway endpoint |
| `NOTIFY_WEBHOOK_SECRET` | | Signs each webhook with `X-RayCare-Signature: sha256=…` |
| `ANTHROPIC_API_KEY` | | Turns on the AI Copilot (optional) |
| `SERVE_WEBSITE` | `true` | `false` sends `/` to the staff app |
| `TRUST_PROXY` | `false` | Set `true` behind nginx, Caddy or a load balancer |
| `TZ` | `Asia/Kolkata` | Hospital time zone |

### Patient messages

RayCare sends three messages per visit, in the patient's language: token issued, three patients ahead, and "your turn". With `NOTIFY_PROVIDER=webhook`, each message is POSTed as JSON:

```json
{ "kind": "near", "to": "9876543210", "lang": "te", "text": "…", "token": "C-121", "visitId": "20260929-C-121", "at": "2026-09-29T05:12:00.000Z" }
```

Point the webhook at your SMS or WhatsApp provider, or at an automation tool. Verify `X-RayCare-Signature` with your shared secret.

### HTTPS

Run RayCare behind a reverse proxy that terminates TLS, for example Caddy:

```
raycare.yourhospital.in {
    reverse_proxy localhost:8080
}
```

Set `TRUST_PROXY=true` and `PUBLIC_URL=https://raycare.yourhospital.in`.

---

## Operations

| Task | Command |
|---|---|
| Start | `npm start` |
| Run tests | `npm test` |
| Back up (safe while running) | `npm run backup` → `data/backups/` (keeps 30) |
| Back up to another disk | `npm run backup -- /mnt/usb` |
| Reset an admin password | `npm run reset-admin -- admin@hospital.in "new password"` |
| Build the static demo | `npm run build:static` → `dist/` |

Restore a backup by stopping RayCare and copying the backup file over `data/raycare.db`.

---

## Architecture

```
 Staff app ─┐                     ┌──────────────── RayCare server ────────────────┐
 Lobby TV  ─┤  REST commands      │  auth · roles · rate limits                     │
 Tracker   ─┼────────────────────▶│  runtime: one command at a time                 │──▶ SQLite (WAL, one file)
 Check-in  ─┘  live stream (SSE)  │  engine: queues · ETA · triage · beds · appts   │──▶ SMS/WhatsApp webhook
            ◀─────────────────────│  notifier · copilot · CSV export                │──▶ Anthropic API (optional)
                                  └─────────────────────────────────────────────────┘
```

- **`shared/engine.js`** holds every business rule. It is pure JavaScript with no dependencies, and the same file runs on the server and in the browser demo.
- Every change is a **command** (`registerPatient`, `callNext`, `triage`, `assignBed`, …) validated by the engine, checked against the user's role, written in one SQLite transaction, streamed to every open screen and recorded in the audit log.
- Node runs one command at a time, so two desks can never call the same patient.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · API reference: [docs/API.md](docs/API.md)

```
server/     Express app, auth, database, runtime, notifications, copilot
shared/     Engine and demo simulator (used by server and browser)
public/     Website, staff app, lobby TV, tracker, check-in
scripts/    Static build, backup, admin reset
test/       Engine and API tests (node --test)
```

---

## Security

- Passwords hashed with scrypt; sessions are signed tokens that expire.
- Role checks on every command (admin, desk, doctor, nurse), enforced on the server.
- Patient tracking links carry a per-visit secret key; the lobby board never shows names.
- Strict security headers (CSP, frame, referrer, permissions) and rate limits on sign-in, check-in and public endpoints.
- Every action is written to an append-only audit log.
- Self-hosted: patient data stays on your server.

---

## License

Proprietary. © 2026 Rayeesa Mahmood. All rights reserved. Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
