# Architecture

## Principles

1. **One source of truth for business rules.** All queue, triage, bed and appointment logic lives in `shared/engine.js`. The server never duplicates it and the browser demo runs the same file.
2. **Every change is a command.** Screens never edit data directly. They send a named command with a payload; the engine validates it, applies it and records what changed.
3. **Boring, dependable storage.** SQLite in WAL mode through Node's built-in driver. One file, transactional, easy to back up, nothing to administer.
4. **Push, don't poll.** Staff screens receive changes over Server-Sent Events the moment they are committed.

## Request lifecycle

```
POST /api/commands/callNext  { "dept": "CAR" }
  │
  ├─ authenticate      verify signed session, load user, reject disabled accounts
  ├─ runtime.exec      single-threaded: one command at a time
  │    ├─ engine.dispatch      role check (COMMANDS table) → validation → business rules
  │    ├─ engine.takeDelta     changed visits, patients, beds, alerts … + audit entries
  │    ├─ store.persist        one SQLite transaction (upserts + audit rows)
  │    ├─ hub.broadcast        SSE "delta" to staff screens, "board" to lobby TVs
  │    └─ notifier.check       queue SMS/WhatsApp messages that are now due
  └─ 200 { ok, result, v }
```

If the database write fails, the runtime reloads the engine from the database so memory never drifts from disk, and the request returns an error.

## Engine state

The engine keeps **today's working set** in memory: today's visits plus anything still waiting, all patients, beds, open admissions, inbound ambulances, today's appointment slots, recent feedback, alerts and audit entries. History stays in SQLite for search, patient history and CSV export.

Each delta carries a version number `v`. Clients apply deltas in order; if one is missed (for example after a network drop) the client reloads the full state.

## Queue rules

- **Order:** ESI 1–2, ESI 3, priority flag (senior, pregnant, disability), appointment, other ESI levels, walk-ins; ties by arrival time (plus any "running late" offset).
- **Consult pace:** the configured average until five consults are complete today, then a blend weighted 70% toward the median of the last 20 real consults.
- **ETA:** remaining time of the current consult plus position × pace.
- **Running late:** moves a patient back three places, at most twice per visit.
- **Day rollover:** tokens restart at 101; unfinished visits close as no-shows.

## Triage (ESI suggestion)

| Level | Triggers |
|---|---|
| 1 Immediate | Responds only to pain or not at all; SpO₂ < 88%; systolic BP < 80 |
| 2 Emergent | Chest pain, stroke signs, breathing difficulty; SpO₂ < 92%; pulse > 120 or < 50; BP > 180; pain ≥ 8 |
| 3 Urgent | Injury, abdominal pain; fever at age > 65 or < 2 |
| 4 Less urgent | Fever, minor injury |
| 5 Non-urgent | No resources needed |

The level is a suggestion for the triage nurse. Doctors can override it with a reason, which is logged.

## Data model (SQLite)

| Table | Contents |
|---|---|
| `meta` | Hospital settings, departments, counters, serving map, recall, code blue |
| `users` | Staff accounts: role, optional department, scrypt hash, active flag |
| `patients` | MRN, name, phone, ABHA, visit list |
| `visits` | One row per token per day with full event timeline (JSON) |
| `beds`, `bed_requests` | Bed status and admission requests |
| `ambulances` | Pre-alerts and arrivals |
| `appointments` | 15-minute slots per department per day |
| `feedback`, `alerts` | Patient ratings and operational alerts |
| `audit_log` | Append-only record of every command |
| `notifications` | Delivery log for patient messages |
| `schema_migrations` | Applied migrations |

Migrations live in `server/db.js` and run automatically at start-up.

## Scaling notes

A single RayCare process comfortably serves one hospital: commands take well under a millisecond and SQLite handles thousands of writes per second. For a hospital network, run one instance per site and aggregate through the CSV export or the webhook stream.
