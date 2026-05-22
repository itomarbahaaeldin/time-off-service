# Time-Off Microservice

NestJS microservice for managing employee time-off requests and syncing leave balances with an external HCM system (Workday, SAP, etc.).

See [TRD.md](./TRD.md) for the full Technical Requirements Document.

## Requirements

- Node.js >= 18 — download from https://nodejs.org (LTS version)
- npm >= 9 (bundled with Node.js)

## Setup

```powershell
cd time-off-human
npm install
```

## Run Tests (main deliverable)

Always delete the database file first to ensure a clean state:

```powershell
Remove-Item -ErrorAction SilentlyContinue timeoff.db; npm test -- --runInBand --forceExit
```

Expected output:
```
Tests:       69 passed, 69 total
Test Suites: 3 passed, 3 total
```

> The red ERROR lines that appear during the run are **intentional** — they are tests that simulate HCM failures (network down, rejected deductions). They prove resilience works.

## Run with Coverage Report

```powershell
Remove-Item -ErrorAction SilentlyContinue timeoff.db; npm run test:cov -- --runInBand --forceExit
```

Coverage: **96%+ statements, 95%+ functions, 69 tests across 3 suites.**

## Run the Server

```powershell
Remove-Item -ErrorAction SilentlyContinue timeoff.db
npm run start:dev
```

Then open your browser at:
```
http://localhost:3000
```

This redirects to the **Swagger UI** at `http://localhost:3000/api/docs` — a full interactive API explorer where you can try every endpoint.

> Note: Without a real HCM at `localhost:4000`, balance refresh and approval will fail. The tests use an automatic mock HCM — no external dependency needed for testing.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DB_PATH` | `timeoff.db` | SQLite file path |
| `HCM_BASE_URL` | `http://localhost:4000` | HCM system base URL |

## API Endpoints

### Balances
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/balances/:employeeId` | Get cached balances (`?refresh=true` to force HCM sync) |
| `GET` | `/balances/:employeeId/:locationId/refresh` | Sync one balance from HCM |
| `GET` | `/balances/:employeeId/:locationId/available` | Balance minus in-flight requests |
| `POST` | `/balances/sync` | Full batch sync from HCM |

### Time-Off Requests
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/time-off-requests` | Create request (validates balance locally first) |
| `GET` | `/time-off-requests/:id` | Get request by ID |
| `GET` | `/time-off-requests` | List (`?employeeId=X&status=PENDING`) |
| `PATCH` | `/time-off-requests/:id/approve` | Approve — refreshes HCM, submits deduction |
| `PATCH` | `/time-off-requests/:id/reject` | Reject (body: `{ "reason": "..." }`) |
| `PATCH` | `/time-off-requests/:id/cancel` | Cancel (PENDING or APPROVED only) |

## Project Structure

```
src/
  home.controller.ts             # Redirects / → Swagger UI
  app.module.ts                  # Root module
  main.ts                        # Bootstrap + Swagger setup
  common/enums.ts                # RequestStatus, SyncType, etc.
  balance/
    balance.entity.ts            # TimeOffBalance (per-employee per-location)
    balance.service.ts           # Cache management + optimistic-lock deduction
    balance.controller.ts        # Balance REST endpoints
  time-off-request/
    time-off-request.entity.ts   # TimeOffRequest with full status lifecycle
    time-off-request.service.ts  # Create / approve / reject / cancel logic
    time-off-request.controller.ts
    dto/time-off-request.dto.ts  # Validated DTOs with Swagger annotations
  hcm/
    hcm.service.ts               # HCM API client (real-time + batch + deductions)
  sync/
    sync.service.ts              # Batch reconciliation + drift detection + flagging
    sync-log.entity.ts           # Audit log for every sync operation
test/
  integration.e2e-spec.ts        # 38 integration tests (full lifecycle)
  time-off-request.service.spec.ts  # 16 unit tests (request service)
  balance.service.spec.ts        # 15 unit tests (balance service + optimistic lock)
  mock-hcm/
    mock-hcm.server.ts           # Configurable mock HCM with failure simulation
TRD.md                           # Technical Requirements Document
```

## Tech Stack

- **NestJS** + **TypeORM** + **better-sqlite3**
- **class-validator** for DTO validation
- **@nestjs/swagger** for interactive API docs
- **Jest** + **Supertest** for testing
- **Express** for the mock HCM server (test-only)
