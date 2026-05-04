# Technical Requirements Document: Time-Off Microservice

## 1. Problem Statement

ReadyOn provides a time-off request interface for employees, but the Human Capital Management (HCM) system (e.g., Workday, SAP) remains the **source of truth** for employment data and leave balances.

This creates a **dual-system consistency problem**:

- Employees expect instant, accurate balance feedback when requesting time off.
- Balances can change in the HCM independently of ReadyOn (e.g., work anniversary bonuses, annual balance resets, manual HR adjustments).
- The HCM may or may not reject invalid requests reliably — we cannot trust it as our sole validation layer.
- Managers need confidence that the data they see during approvals is valid.

The microservice must bridge these two systems while maintaining balance integrity, handling sync failures gracefully, and providing a responsive user experience.

## 2. Key Challenges

| # | Challenge | Impact |
|---|-----------|--------|
| C1 | **Stale local balances** — HCM balances change independently via anniversary bonuses, year-start resets, and HR adjustments | Employee sees incorrect available balance; may submit invalid requests |
| C2 | **Write consistency** — A request approved locally may be rejected by HCM if balances drifted | Request enters an inconsistent state; employee and manager see conflicting information |
| C3 | **HCM validation unreliability** — HCM error responses are not guaranteed for all invalid combinations | If we rely solely on HCM validation, invalid requests could silently succeed |
| C4 | **Network failures** — HCM real-time API may be temporarily unavailable | System must degrade gracefully without blocking employees indefinitely |
| C5 | **Concurrent requests** — Two requests for the same employee's balance submitted simultaneously | Race condition could over-deduct balance |
| C6 | **Multi-dimensional balances** — Balances are per-employee, per-location; invalid dimension combinations exist | Must validate dimensional constraints locally, not just balance sufficiency |

## 3. Architecture

### 3.1 High-Level Design

```
┌────────────┐       ┌──────────────────────┐       ┌─────────┐
│  Employee / │       │  Time-Off            │       │         │
│  Manager    │◄─────►│  Microservice        │◄─────►│  HCM    │
│  (Client)   │  REST │                      │  API  │  System │
└────────────┘       │  ┌────────────────┐  │       └─────────┘
                      │  │  SQLite (Cache) │  │
                      │  └────────────────┘  │
                      └──────────────────────┘
```

### 3.2 Design Principles

1. **HCM-authoritative writes**: Every time-off deduction is submitted to HCM before being committed locally. Local storage is a **read cache**, not a competing source of truth.
2. **Defensive local validation**: Pre-validate balance sufficiency and dimensional constraints locally *before* calling HCM. This catches errors even when HCM validation is unreliable (C3).
3. **Eventual consistency for reads**: Serve balances from the local cache for speed, but expose a freshness indicator. Provide an on-demand refresh mechanism.
4. **Periodic reconciliation**: Use HCM's batch endpoint to detect and correct drift (C1).
5. **Idempotent operations**: All write operations use idempotency keys to safely retry on network failures (C4).

### 3.3 Request Lifecycle (State Machine)

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

- **PENDING**: Created by employee, awaiting manager approval.
- **APPROVED**: Manager approved; system will now submit to HCM.
- **SUBMITTED_TO_HCM**: Sent to HCM, awaiting confirmation.
- **CONFIRMED**: HCM accepted the deduction. Balance updated locally.
- **HCM_REJECTED**: HCM rejected the deduction (insufficient balance, invalid dimensions, etc.). Manager and employee are notified.
- **REJECTED**: Manager denied the request.
- **CANCELLED**: Employee or manager cancelled before HCM submission.

## 4. Data Model

### 4.1 Entities

**TimeOffBalance**
| Column | Type | Description |
|--------|------|-------------|
| id | UUID (PK) | |
| employeeId | string | Employee identifier |
| locationId | string | Location identifier |
| balance | decimal | Current cached balance (days) |
| lastSyncedAt | datetime | When this balance was last confirmed by HCM |
| version | integer | Optimistic lock version for concurrent updates |
| createdAt | datetime | |
| updatedAt | datetime | |

*Unique constraint on (employeeId, locationId)*

**TimeOffRequest**
| Column | Type | Description |
|--------|------|-------------|
| id | UUID (PK) | |
| employeeId | string | |
| locationId | string | |
| startDate | date | First day of leave |
| endDate | date | Last day of leave |
| days | decimal | Number of leave days requested |
| status | enum | PENDING / APPROVED / SUBMITTED_TO_HCM / CONFIRMED / HCM_REJECTED / REJECTED / CANCELLED |
| reason | string (nullable) | Employee's reason for time off |
| rejectionReason | string (nullable) | Reason for rejection (manager or HCM) |
| idempotencyKey | string (unique) | For safe retries of HCM submissions |
| hmcReferenceId | string (nullable) | Reference ID returned by HCM |
| createdAt | datetime | |
| updatedAt | datetime | |

**SyncLog**
| Column | Type | Description |
|--------|------|-------------|
| id | UUID (PK) | |
| syncType | enum | BATCH / REALTIME / ON_DEMAND |
| status | enum | SUCCESS / PARTIAL_FAILURE / FAILURE |
| recordsProcessed | integer | |
| recordsUpdated | integer | |
| errors | text (nullable) | JSON array of errors encountered |
| startedAt | datetime | |
| completedAt | datetime (nullable) | |

## 5. API Design

### 5.1 Balance Endpoints

**GET /balances/:employeeId**
Returns all balances for an employee across locations.
- Query params: `?locationId=X` (optional filter), `?refresh=true` (force HCM sync)
- Response includes `lastSyncedAt` so clients can assess freshness.

**POST /balances/sync**
Triggers a batch sync from HCM. Intended for scheduled jobs or admin use.
- Response: sync summary (records processed, updated, errors).

**GET /balances/:employeeId/:locationId/refresh**
Fetches the real-time balance from HCM for a specific employee-location pair, updates local cache, and returns the fresh value.

### 5.2 Time-Off Request Endpoints

**POST /time-off-requests**
Creates a new time-off request.
- Body: `{ employeeId, locationId, startDate, endDate, days, reason? }`
- Validates: balance sufficiency (local), date sanity, dimensional validity.
- Returns the created request in PENDING status.

**GET /time-off-requests/:id**
Returns a single request with full details.

**GET /time-off-requests?employeeId=X&status=Y**
Lists requests with optional filters.

**PATCH /time-off-requests/:id/approve**
Manager approves a request. Triggers HCM submission flow:
1. Re-validates balance (fetches fresh balance from HCM).
2. Submits deduction to HCM.
3. If HCM confirms → status becomes CONFIRMED, local balance decremented.
4. If HCM rejects → status becomes HCM_REJECTED with reason.

**PATCH /time-off-requests/:id/reject**
Manager rejects a request. Body: `{ reason }`.

**PATCH /time-off-requests/:id/cancel**
Cancels a request (only if status is PENDING or APPROVED, not yet submitted to HCM).

## 6. Sync Strategy

### 6.1 Real-Time Sync (On-Demand)

- Triggered when: (a) employee views their balance with `?refresh=true`, or (b) manager approves a request (pre-submission validation).
- Calls HCM real-time API for a single employee-location pair.
- Updates local cache atomically.

### 6.2 Batch Sync (Periodic Reconciliation)

- Triggered by: scheduled job (e.g., nightly) or manual admin trigger via `POST /balances/sync`.
- HCM sends the full corpus of time-off balances.
- For each record:
  - If local balance differs from HCM → update local to match HCM (HCM is authoritative).
  - If employee-location pair exists in HCM but not locally → create it.
  - If pair exists locally but not in HCM → flag for review (do not auto-delete).
- Drift detected during batch sync is logged in SyncLog for audit.

### 6.3 Conflict Resolution

**Rule: HCM always wins.** Local cache exists for read performance only. When drift is detected:

1. Update local balance to match HCM.
2. Check for any PENDING/APPROVED requests against the updated balance.
3. If an in-flight request would now exceed the balance, flag it for manager review (do not auto-cancel — the manager made an approval decision and should be informed).

## 7. Error Handling & Resilience

| Scenario | Strategy |
|----------|----------|
| HCM real-time API unavailable | Return cached balance with a `stale: true` flag. Block approvals (require fresh balance). |
| HCM rejects a deduction | Move request to HCM_REJECTED. Do not modify local balance. |
| HCM batch sync partially fails | Log failures, update successful records. Return PARTIAL_FAILURE status. |
| Concurrent balance modifications | Optimistic locking via version column. Retry on conflict (max 3 attempts). |
| Invalid dimension combination | Reject locally before calling HCM. Return 400 with descriptive error. |

## 8. Alternatives Considered

### 8.1 Event-Driven (Webhook/Queue) vs. Synchronous HCM Calls

**Considered**: Having HCM push balance changes to ReadyOn via webhooks or a message queue.

**Rejected because**: The problem statement specifies HCM exposes a real-time API and a batch endpoint — not webhooks. Building around a push model would require HCM-side changes we don't control. The batch sync already provides eventual consistency for external changes. If HCM adds webhook support in the future, it can be layered on as an optimization without architectural changes.

### 8.2 ReadyOn as Source of Truth for Balances

**Considered**: Maintaining balances primarily in ReadyOn and syncing *to* HCM.

**Rejected because**: HCM is updated by multiple systems (anniversary bonuses, payroll, HR manual adjustments). Making ReadyOn authoritative would require all these systems to route through ReadyOn — an unrealistic organizational change. HCM-authoritative is the only viable model given the integration landscape.

### 8.3 No Local Balance Cache (Always Call HCM)

**Considered**: Every balance read calls HCM in real-time.

**Rejected because**: Latency impact on employee experience (balance lookups happen frequently). HCM rate limits could throttle the system. HCM downtime would make ReadyOn completely non-functional. A local cache with known staleness is a better UX tradeoff.

### 8.4 GraphQL vs. REST

**Considered**: GraphQL for flexible querying (e.g., fetch request + balance in one call).

**Decided REST** because: The domain has well-defined resources with predictable access patterns. REST is simpler to implement, cache, and debug. The number of endpoints is small enough that the flexibility of GraphQL doesn't justify its overhead. If ReadyOn later needs a unified BFF (Backend for Frontend), GraphQL can be added as a gateway layer on top of this service.

### 8.5 Pessimistic vs. Optimistic Locking for Concurrent Requests

**Considered**: Database-level row locks during request creation.

**Chose optimistic locking** because: Contention is low (same employee requesting time off simultaneously is rare). Optimistic locking via a version column avoids holding database locks during network calls to HCM. Retry logic handles the rare collision gracefully.

## 9. Security Considerations

- **Authentication/Authorization**: Endpoints should be protected by the platform's auth layer (JWT / session-based). This microservice trusts the upstream gateway to authenticate.
- **Employee data isolation**: Employees can only query/create requests for their own employeeId. Managers can view/approve requests for their direct reports. Enforcement is at the API layer.
- **Audit trail**: All state transitions on TimeOffRequest are timestamped. SyncLog provides a full history of balance reconciliations.
- **Input validation**: All inputs are validated using class-validator decorators. Dates, numeric ranges, and string lengths are enforced.

## 10. Testing Strategy

| Layer | What's Tested | Approach |
|-------|--------------|----------|
| **Unit** | Services, validation logic, state transitions | Jest with mocked dependencies |
| **Integration** | Full request lifecycle, database interactions, API contracts | Supertest against a running NestJS app with in-memory SQLite |
| **Mock HCM** | HCM real-time and batch endpoints | Dedicated Express mock server with configurable responses |
| **Edge cases** | Concurrent requests, sync conflicts, HCM failures, stale data handling | Targeted integration tests with controlled mock behavior |

Coverage target: >85% line coverage across services and controllers.

## 11. Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Framework | NestJS | Required by spec. Provides DI, modular architecture, built-in testing support. |
| Database | SQLite via TypeORM | Required by spec. Lightweight, zero-config, suitable for per-service embedded storage. |
| ORM | TypeORM | First-class NestJS integration. Supports migrations, entities, and query builder. |
| Validation | class-validator + class-transformer | NestJS standard. Declarative DTO validation. |
| HTTP Client | Axios (via @nestjs/axios or direct) | For HCM API calls. Supports interceptors, retries. |
| Testing | Jest + Supertest | NestJS default test tooling. |
| API Docs | @nestjs/swagger | Auto-generated OpenAPI spec from decorators. |
