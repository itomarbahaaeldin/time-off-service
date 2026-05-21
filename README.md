<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:E0234E,50:9b1a37,100:1a0a10&height=180&section=header&text=Time-Off%20Service&fontSize=42&fontColor=ffffff&fontAlignY=38&desc=Enterprise%20NestJS%20Microservice%20%7C%2096%25%2B%20Test%20Coverage&descAlignY=58&descSize=16&animation=fadeIn" width="100%"/>

<br/>

![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?style=flat-square&logo=nestjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/Tests-68%20passed-22c55e?style=flat-square&logo=jest&logoColor=white)
![Coverage](https://img.shields.io/badge/Coverage-96%25%2B-22c55e?style=flat-square&logo=jest&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

</div>

<br/>

## 📋 Overview

An enterprise-grade **NestJS microservice** that manages employee time-off requests and synchronises leave balances with an external HCM system (Workday, SAP, etc.).

The core challenge: employees need **instant, accurate balance feedback** while the HCM remains the authoritative source of truth — and it can change balances independently at any time. This service bridges that gap with a local cache, optimistic locking, and resilient HCM integration.

<br/>

## ⚡ The Problem It Solves

| Challenge | Solution |
|-----------|----------|
| **Stale balances** — HCM changes independently (bonuses, resets, HR adjustments) | Local cache + periodic batch reconciliation + on-demand refresh |
| **Write consistency** — Approved request may be rejected by HCM after drift | HCM-authoritative writes: deduction submitted to HCM *before* local commit |
| **Race conditions** — Two requests submitted simultaneously over-deduct balance | Optimistic locking on `version` column |
| **HCM downtime** — Network failures block employees | Graceful degradation; local validation first, HCM call after |
| **Unreliable HCM validation** — HCM doesn't always reject invalid combos | Defensive local pre-validation before any HCM call |

<br/>

## 🏗️ Architecture

```
┌────────────┐       ┌──────────────────────┐       ┌─────────┐
│  Employee / │       │   Time-Off           │       │         │
│  Manager   │◄─────►│   Microservice       │◄─────►│   HCM   │
│  (Client)  │  REST │                      │  API  │  System │
└────────────┘       │  ┌────────────────┐  │       └─────────┘
                     │  │ SQLite (Cache) │  │
                     │  └────────────────┘  │
                     └──────────────────────┘
```

**Design principles:**
- 🔒 **HCM-authoritative writes** — local DB is a read cache, not a competing source of truth
- 🛡️ **Defensive local validation** — pre-validate before calling HCM (catches errors when HCM is unreliable)
- ⚡ **Eventual consistency for reads** — serve from cache for speed, expose freshness indicator
- 🔄 **Periodic reconciliation** — batch sync to detect and correct drift
- 🔁 **Idempotent operations** — safe to retry on network failures

<br/>

## 🔄 Request Lifecycle

```
PENDING ──► APPROVED ──► SUBMITTED_TO_HCM ──► CONFIRMED
   │            │                │
   │            │                ▼
   │            │           HCM_REJECTED
   │            ▼
   │        CANCELLED
   ▼
REJECTED (by manager)
```

<br/>

## 🚀 Quick Start

**Prerequisites:** Node.js ≥ 18, npm ≥ 9

```bash
git clone https://github.com/itomarbahaaeldin/time-off-service.git
cd time-off-service/time-off-service
npm install
```

**Run tests (main deliverable):**
```bash
# Windows
Remove-Item -ErrorAction SilentlyContinue timeoff.db; npm test -- --runInBand --forceExit

# Linux / Mac
rm -f timeoff.db && npm test -- --runInBand --forceExit
```

Expected output:
```
Tests:       68 passed, 68 total
Test Suites: 3 passed, 3 total
```

> ℹ️ Red `ERROR` lines during the test run are **intentional** — they simulate HCM failures (network down, rejected deductions) to prove resilience works.

**Run with coverage:**
```bash
rm -f timeoff.db && npm run test:cov -- --runInBand --forceExit
```

**Start the server:**
```bash
rm -f timeoff.db && npm run start:dev
```

Then open **[http://localhost:3000/api/docs](http://localhost:3000/api/docs)** for the full interactive Swagger UI.

> ⚠️ Without a real HCM at `localhost:4000`, balance refresh and approval will fail. Tests use an automatic mock HCM — no external dependency needed for testing.

<br/>

## 🌐 API Reference

### Balances

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/balances/:employeeId` | Get cached balances (`?refresh=true` forces HCM sync) |
| `GET` | `/balances/:employeeId/:locationId/refresh` | Sync one balance from HCM |
| `GET` | `/balances/:employeeId/:locationId/available` | Balance minus in-flight requests |
| `POST` | `/balances/sync` | Full batch sync from HCM |

### Time-Off Requests

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/time-off-requests` | Create request (validates balance locally first) |
| `GET` | `/time-off-requests/:id` | Get request by ID |
| `GET` | `/time-off-requests` | List (`?employeeId=X&status=PENDING`) |
| `PATCH` | `/time-off-requests/:id/approve` | Approve — refreshes HCM, submits deduction |
| `PATCH` | `/time-off-requests/:id/reject` | Reject with reason |
| `PATCH` | `/time-off-requests/:id/cancel` | Cancel (PENDING or APPROVED only) |

<br/>

## 🧪 Test Coverage

| Suite | Tests | What's covered |
|-------|-------|---------------|
| `integration.e2e-spec.ts` | 37 | Full request lifecycle, HCM failure scenarios, concurrent requests |
| `time-off-request.service.spec.ts` | 16 | Request creation, approval, rejection, cancellation logic |
| `balance.service.spec.ts` | 15 | Cache management, optimistic locking, drift detection |
| **Total** | **68** | **96%+ statements · 95%+ functions** |

<br/>

## 🗂️ Project Structure

```
src/
├── common/enums.ts                     # RequestStatus, SyncType, etc.
├── balance/
│   ├── balance.entity.ts               # TimeOffBalance (per-employee, per-location)
│   ├── balance.service.ts              # Cache + optimistic-lock deduction
│   └── balance.controller.ts           # Balance REST endpoints
├── time-off-request/
│   ├── time-off-request.entity.ts      # Full status lifecycle entity
│   ├── time-off-request.service.ts     # Create / approve / reject / cancel
│   ├── time-off-request.controller.ts
│   └── dto/time-off-request.dto.ts     # Validated DTOs with Swagger annotations
├── hcm/
│   └── hcm.service.ts                  # HCM API client (real-time + batch + deductions)
└── sync/
    ├── sync.service.ts                 # Batch reconciliation + drift detection
    └── sync-log.entity.ts              # Audit log for every sync operation

test/
├── integration.e2e-spec.ts             # 37 integration tests
├── time-off-request.service.spec.ts    # 16 unit tests
├── balance.service.spec.ts             # 15 unit tests
└── mock-hcm/
    └── mock-hcm.server.ts              # Configurable mock HCM with failure simulation
```

<br/>

## ⚙️ Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DB_PATH` | `timeoff.db` | SQLite file path |
| `HCM_BASE_URL` | `http://localhost:4000` | HCM system base URL |

<br/>

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | NestJS 11 |
| Language | TypeScript 5.7 |
| ORM | TypeORM + better-sqlite3 |
| Validation | class-validator + class-transformer |
| API Docs | @nestjs/swagger (Swagger UI) |
| Testing | Jest + Supertest |
| Mock Server | Express (test-only) |

<br/>

## 📄 License

MIT © [Omar Bahaa Eldin](https://github.com/itomarbahaaeldin)

<div align="center">
<br/>
<img src="https://capsule-render.vercel.app/api?type=waving&color=0:1a0a10,50:9b1a37,100:E0234E&height=100&section=footer" width="100%"/>
</div>
