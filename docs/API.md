# API reference

All responses are JSON. Errors use one shape:

```json
{ "error": { "code": "invalid", "message": "Name is required" } }
```

| Status | Meaning |
|---|---|
| 400 | Invalid input (`invalid`, `bad_json`) |
| 401 | Missing or expired session (`unauthorized`, `bad_credentials`) |
| 403 | Role not allowed (`forbidden`) |
| 404 | Not found |
| 409 | Business rule conflict (`duplicate`, `closed`, `no_bed`, `limit`, `already_setup`, `not_setup`) |
| 429 | Rate limited (see `Retry-After`) |

## Setup and auth

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ ok, version, ready, demo, now, clockRate }` |
| GET | `/api/setup/status` | Whether the wizard is needed; department templates and languages |
| POST | `/api/setup` | First run only. Body: `{ hospital:{name,city,langs,publicCheckin}, depts:[{id,room,doc,avg?}], wards:{ICU,GW,PW}, admin:{name,email,password} }`. Returns `{ token, user }` |
| POST | `/api/auth/login` | `{ email, password }` → `{ token, user }`. 10 attempts per minute per IP |
| GET | `/api/auth/me` | Current user |

Send the token as `Authorization: Bearer <token>`.

## Staff API (signed in)

| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/api/state` | all | Full working state, server time, features |
| GET | `/api/stream?access_token=…` | all | SSE. Events: `hello {v, now}`, `delta {v, now, meta?, visits?, …}` |
| POST | `/api/commands/:name` | per command | Body is the command payload. Returns `{ ok, result, v, now }` |
| GET | `/api/patients/search?q=` | all | Searches all records, not just today |
| GET | `/api/patients/:pid` | all | Patient and full visit history |
| GET/POST | `/api/users` | admin | List or create staff accounts |
| PATCH | `/api/users/:id` | admin | `{ name?, role?, dept?, active?, password? }` |
| GET | `/api/audit?limit=&before=` | admin | Paged audit log |
| GET | `/api/export/visits.csv?from=YYYYMMDD&to=YYYYMMDD` | admin | CSV (UTF-8 with BOM, spreadsheet-safe) |
| POST | `/api/copilot` | all | `{ messages:[{role,content}] }` → `{ text, actions }`. Needs `ANTHROPIC_API_KEY` |

### Commands

| Command | Allowed roles | Payload |
|---|---|---|
| `registerPatient` | admin, desk | `name, dept, phone?, age?, sex?, abha?, lang?, priority?` |
| `callNext` | admin, desk, doctor, nurse | `dept` |
| `callVisit` | admin, desk, doctor, nurse | `id` |
| `completeVisit` | admin, doctor, nurse | `dept, outcome \| referTo, callNext?` |
| `markNoShow` | admin, desk, doctor, nurse | `id` |
| `recall` | admin, desk, doctor, nurse | `dept` |
| `runningLate` | admin, desk | `id` |
| `triage` | admin, nurse, doctor | `name?, age?, complaint, spo2?, hr?, bp?, avpu?, pain?` |
| `overrideEsi` | admin, doctor | `id, esi, reason` |
| `ambulancePreAlert` | admin, nurse, desk | `from, complaint, esi, etaMin` |
| `prepareBay` | admin, nurse, doctor | `id` |
| `assignBed` | admin, nurse | `reqId?, bedId?` |
| `dischargeBed` | admin, nurse, doctor | `bedId` |
| `markBedReady` | admin, nurse | `bedId` |
| `bookAppointment` | admin, desk | `slotId, name, phone?` |
| `checkInAppointment` | admin, desk | `slotId` |
| `submitFeedback` | admin, desk | `id, stars, text?` |
| `updateSettings` | admin | `name?, city?, sla?:{busy,over}, langs?, publicCheckin?` |
| `updateDepartment` | admin | `id, avg?, open?, doc?, room?` |
| `addDepartment` | admin | `id, room, doc, name?` |
| `codeBlue` | admin, nurse, doctor, desk | `location` |
| `clearCodeBlue` | admin, nurse, doctor | |
| `ackAlerts` | admin, desk, doctor, nurse | `id?` |

Outcomes: `Prescription issued`, `Lab tests ordered`, `Imaging ordered`, `Follow-up in 2 weeks`, `Discharged home`, `Admit`.

## Public API (no sign-in)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/public/info` | Hospital name, languages, departments with current wait |
| GET | `/api/public/board` | Lobby board: tokens only, never names |
| GET | `/api/public/stream` | SSE `board` events |
| POST | `/api/public/checkin` | `{ name, phone, dept, lang?, age?, consent:true }` → token and `trackUrl`. 6 per 10 minutes per IP |
| GET | `/api/public/visit/:id?k=` | A patient's live status. `k` is the visit's secret key |
| POST | `/api/public/visit/:id/late?k=` | "Running late" |
| POST | `/api/public/visit/:id/feedback?k=` | `{ stars, text? }` after the visit |
