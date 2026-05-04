import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
const request = require('supertest');
import { Server } from 'http';
import * as fs from 'fs';
import { AppModule } from '../src/app.module';
import {
  createMockHcmConfig,
  startMockHcmServer,
  stopMockHcmServer,
  MockHcmConfig,
} from './mock-hcm/mock-hcm.server';
import { RequestStatus } from '../src/common/enums';

const DB_PATH = `/tmp/test-integration-${Date.now()}.db`;

describe('Time-Off Microservice (Integration)', () => {
  let app: INestApplication;
  let hcmServer: Server;
  let hcmConfig: MockHcmConfig;

  beforeAll(async () => {
    // Clean up any leftover DB
    try { fs.unlinkSync(DB_PATH); } catch { /* ignore */ }

    // Start mock HCM with seed data
    hcmConfig = createMockHcmConfig([
      { employeeId: 'emp-1', locationId: 'loc-1', balance: 10 },
      { employeeId: 'emp-1', locationId: 'loc-2', balance: 5 },
      { employeeId: 'emp-2', locationId: 'loc-1', balance: 20 },
      { employeeId: 'emp-3', locationId: 'loc-1', balance: 12 },
      { employeeId: 'emp-4', locationId: 'loc-1', balance: 15 },
    ]);
    hcmServer = await startMockHcmServer(hcmConfig, 4020);

    process.env.HCM_BASE_URL = 'http://localhost:4020';
    process.env.DB_PATH = DB_PATH;

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
    if (hcmServer) await stopMockHcmServer(hcmServer);
    try { fs.unlinkSync(DB_PATH); } catch { /* ignore */ }
  }, 10000);

  // ═══════════════════════════════════════════════════════════════════════
  //  BALANCE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  describe('Balance Management', () => {
    it('should refresh balance from HCM and cache locally', async () => {
      const res = await request(app.getHttpServer())
        .get('/balances/emp-1/loc-1/refresh')
        .expect(200);

      expect(res.body.employeeId).toBe('emp-1');
      expect(res.body.locationId).toBe('loc-1');
      expect(res.body.balance).toBe(10);
      expect(res.body.lastSyncedAt).toBeDefined();
    });

    it('should return cached balances for an employee', async () => {
      await request(app.getHttpServer())
        .get('/balances/emp-1/loc-2/refresh')
        .expect(200);

      const res = await request(app.getHttpServer())
        .get('/balances/emp-1')
        .expect(200);

      expect(res.body.employeeId).toBe('emp-1');
      expect(res.body.balances).toHaveLength(2);
      expect(res.body.balances.map((b: any) => b.locationId).sort()).toEqual([
        'loc-1',
        'loc-2',
      ]);
    });

    it('should filter balances by locationId', async () => {
      const res = await request(app.getHttpServer())
        .get('/balances/emp-1?locationId=loc-1')
        .expect(200);

      expect(res.body.balances).toHaveLength(1);
      expect(res.body.balances[0].locationId).toBe('loc-1');
    });

    it('should return available balance accounting for in-flight requests', async () => {
      const res = await request(app.getHttpServer())
        .get('/balances/emp-1/loc-1/available')
        .expect(200);

      expect(res.body.total).toBe(10);
      expect(res.body.reserved).toBe(0);
      expect(res.body.available).toBe(10);
    });

    it('should mark recently synced balances as not stale', async () => {
      const res = await request(app.getHttpServer())
        .get('/balances/emp-1?locationId=loc-1')
        .expect(200);

      expect(res.body.balances[0].stale).toBe(false);
    });

    it('should return 404 for available balance of unknown employee-location', async () => {
      await request(app.getHttpServer())
        .get('/balances/unknown-emp/unknown-loc/available')
        .expect(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  BATCH SYNC
  // ═══════════════════════════════════════════════════════════════════════

  describe('Batch Sync', () => {
    it('should populate local balances from HCM batch endpoint', async () => {
      const syncRes = await request(app.getHttpServer())
        .post('/balances/sync')
        .expect(201);

      expect(syncRes.body.recordsProcessed).toBe(5);
      expect(syncRes.body.errors).toEqual([]);
    });

    it('should detect and correct drift during batch sync', async () => {
      // Simulate HCM balance change (anniversary bonus)
      hcmConfig.balances.set('emp-4:loc-1', {
        employeeId: 'emp-4',
        locationId: 'loc-1',
        balance: 25, // Was 15, now 25
      });

      const syncRes = await request(app.getHttpServer())
        .post('/balances/sync')
        .expect(201);

      expect(syncRes.body.recordsUpdated).toBeGreaterThanOrEqual(1);

      const balRes = await request(app.getHttpServer())
        .get('/balances/emp-4?locationId=loc-1')
        .expect(200);

      expect(balRes.body.balances[0].balance).toBe(25);
    });

    it('should handle new employee-location pairs appearing in HCM', async () => {
      hcmConfig.balances.set('emp-new:loc-1', {
        employeeId: 'emp-new',
        locationId: 'loc-1',
        balance: 30,
      });

      await request(app.getHttpServer())
        .post('/balances/sync')
        .expect(201);

      const balRes = await request(app.getHttpServer())
        .get('/balances/emp-new?locationId=loc-1')
        .expect(200);

      expect(balRes.body.balances[0].balance).toBe(30);
    });

    it('should handle batch sync failure gracefully', async () => {
      hcmConfig.simulateBatchFailure = true;

      const syncRes = await request(app.getHttpServer())
        .post('/balances/sync')
        .expect(201);

      expect(syncRes.body.errors.length).toBeGreaterThan(0);

      hcmConfig.simulateBatchFailure = false;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  BALANCE DRIFT DETECTION
  // ═══════════════════════════════════════════════════════════════════════

  describe('Balance Drift Detection', () => {
    it('should detect when HCM balance changes externally on refresh', async () => {
      // emp-4 currently has 25 locally. Simulate year-start reset to 40.
      hcmConfig.balances.set('emp-4:loc-1', {
        employeeId: 'emp-4',
        locationId: 'loc-1',
        balance: 40,
      });

      const refreshRes = await request(app.getHttpServer())
        .get('/balances/emp-4/loc-1/refresh')
        .expect(200);

      expect(refreshRes.body.balance).toBe(40);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  REQUEST CREATION
  // ═══════════════════════════════════════════════════════════════════════

  describe('Request Creation', () => {
    it('should create a time-off request in PENDING status', async () => {
      const res = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          startDate: '2027-06-01',
          endDate: '2027-06-02',
          days: 2,
          reason: 'Vacation',
        })
        .expect(201);

      expect(res.body.status).toBe(RequestStatus.PENDING);
      expect(res.body.employeeId).toBe('emp-1');
      expect(res.body.days).toBe(2);
      expect(res.body.idempotencyKey).toBeDefined();
    });

    it('should reject request when balance is insufficient', async () => {
      const res = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-1',
          locationId: 'loc-2',
          startDate: '2027-07-01',
          endDate: '2027-07-10',
          days: 15,
        })
        .expect(400);

      expect(res.body.message).toContain('Insufficient balance');
    });

    it('should reject request when startDate > endDate', async () => {
      const res = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          startDate: '2027-06-10',
          endDate: '2027-06-01',
          days: 2,
        })
        .expect(400);

      expect(res.body.message).toContain('startDate must be before');
    });

    it('should reject request with past startDate', async () => {
      const res = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          startDate: '2020-01-01',
          endDate: '2020-01-02',
          days: 1,
        })
        .expect(400);

      expect(res.body.message).toContain('past');
    });

    it('should reject request with empty employeeId', async () => {
      await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: '',
          locationId: 'loc-1',
          startDate: '2027-06-01',
          endDate: '2027-06-02',
          days: 2,
        })
        .expect(400);
    });

    it('should reject request with days <= 0', async () => {
      await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          startDate: '2027-06-01',
          endDate: '2027-06-02',
          days: 0,
        })
        .expect(400);
    });

    it('should reject request for non-existent employee-location balance', async () => {
      const res = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-unknown',
          locationId: 'loc-1',
          startDate: '2027-06-01',
          endDate: '2027-06-02',
          days: 1,
        })
        .expect(400);

      expect(res.body.message).toContain('No balance record found');
    });

    it('should account for in-flight requests when validating balance', async () => {
      // emp-1, loc-2 has 5 days. Create a 4-day request (PENDING).
      await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-1',
          locationId: 'loc-2',
          startDate: '2027-08-01',
          endDate: '2027-08-04',
          days: 4,
          reason: 'Trip',
        })
        .expect(201);

      // Now try to create another 4-day request — should fail (only 1 available)
      const res = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-1',
          locationId: 'loc-2',
          startDate: '2027-09-01',
          endDate: '2027-09-04',
          days: 4,
        })
        .expect(400);

      expect(res.body.message).toContain('Insufficient balance');
    });

    it('should strip unexpected fields from the body', async () => {
      await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-2',
          locationId: 'loc-1',
          startDate: '2027-06-01',
          endDate: '2027-06-01',
          days: 1,
          malicious: 'data',
        })
        .expect(400); // forbidNonWhitelisted rejects extra fields
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  REQUEST QUERIES
  // ═══════════════════════════════════════════════════════════════════════

  describe('Request Queries', () => {
    it('should get a request by ID', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-2',
          locationId: 'loc-1',
          startDate: '2027-06-15',
          endDate: '2027-06-15',
          days: 1,
        })
        .expect(201);

      const getRes = await request(app.getHttpServer())
        .get(`/time-off-requests/${createRes.body.id}`)
        .expect(200);

      expect(getRes.body.id).toBe(createRes.body.id);
      expect(getRes.body.employeeId).toBe('emp-2');
    });

    it('should return 404 for non-existent request', async () => {
      await request(app.getHttpServer())
        .get('/time-off-requests/00000000-0000-0000-0000-000000000000')
        .expect(404);
    });

    it('should list requests filtered by employeeId', async () => {
      const res = await request(app.getHttpServer())
        .get('/time-off-requests?employeeId=emp-2')
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      for (const r of res.body) {
        expect(r.employeeId).toBe('emp-2');
      }
    });

    it('should list requests filtered by status', async () => {
      const res = await request(app.getHttpServer())
        .get(`/time-off-requests?status=${RequestStatus.PENDING}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      for (const r of res.body) {
        expect(r.status).toBe(RequestStatus.PENDING);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  APPROVAL FLOW (HCM INTEGRATION)
  // ═══════════════════════════════════════════════════════════════════════

  describe('Approval Flow (HCM Integration)', () => {
    it('should approve, submit to HCM, and confirm a request', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-2',
          locationId: 'loc-1',
          startDate: '2027-07-01',
          endDate: '2027-07-02',
          days: 2,
        })
        .expect(201);

      const approveRes = await request(app.getHttpServer())
        .patch(`/time-off-requests/${createRes.body.id}/approve`)
        .expect(200);

      expect(approveRes.body.status).toBe(RequestStatus.CONFIRMED);
      expect(approveRes.body.hcmReferenceId).toBeDefined();
      expect(approveRes.body.hcmReferenceId).toContain('HCM-REF-');

      // HCM should have received the deduction
      expect(hcmConfig.submittedDeductions.length).toBeGreaterThan(0);
      const lastDeduction =
        hcmConfig.submittedDeductions[hcmConfig.submittedDeductions.length - 1];
      expect(lastDeduction.employeeId).toBe('emp-2');
      expect(lastDeduction.days).toBe(2);
    });

    it('should update local balance after HCM confirmation', async () => {
      const refreshRes = await request(app.getHttpServer())
        .get('/balances/emp-2/loc-1/refresh')
        .expect(200);

      // HCM balance should have decreased from the deduction
      expect(refreshRes.body.balance).toBeLessThan(20);
    });

    it('should move to HCM_REJECTED when HCM rejects deduction', async () => {
      hcmConfig.rejectDeductions = true;
      hcmConfig.deductionErrorMessage = 'Policy violation: blackout period';

      const createRes = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-2',
          locationId: 'loc-1',
          startDate: '2027-08-01',
          endDate: '2027-08-01',
          days: 1,
        })
        .expect(201);

      const approveRes = await request(app.getHttpServer())
        .patch(`/time-off-requests/${createRes.body.id}/approve`)
        .expect(200);

      expect(approveRes.body.status).toBe(RequestStatus.HCM_REJECTED);
      expect(approveRes.body.rejectionReason).toContain('blackout period');

      hcmConfig.rejectDeductions = false;
      hcmConfig.deductionErrorMessage = undefined;
    });

    it('should fail approval when HCM balance API is down', async () => {
      hcmConfig.simulateBalanceFailure = true;

      const createRes = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-2',
          locationId: 'loc-1',
          startDate: '2027-09-01',
          endDate: '2027-09-01',
          days: 1,
        })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/time-off-requests/${createRes.body.id}/approve`)
        .expect(400);

      hcmConfig.simulateBalanceFailure = false;
    });

    it('should not approve a non-PENDING request', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-2',
          locationId: 'loc-1',
          startDate: '2027-10-01',
          endDate: '2027-10-01',
          days: 1,
        })
        .expect(201);

      // Reject it first
      await request(app.getHttpServer())
        .patch(`/time-off-requests/${createRes.body.id}/reject`)
        .send({ reason: 'No coverage' })
        .expect(200);

      // Now try to approve — should fail with 409
      await request(app.getHttpServer())
        .patch(`/time-off-requests/${createRes.body.id}/approve`)
        .expect(409);
    });

    it('should reject approval when HCM balance dropped below request amount', async () => {
      // emp-3, loc-1 has 12 days. Seed it.
      await request(app.getHttpServer())
        .get('/balances/emp-3/loc-1/refresh')
        .expect(200);

      // Create a 10-day request
      const createRes = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-3',
          locationId: 'loc-1',
          startDate: '2027-06-01',
          endDate: '2027-06-10',
          days: 10,
        })
        .expect(201);

      // Simulate HCM balance dropping to 5 externally
      hcmConfig.balances.set('emp-3:loc-1', {
        employeeId: 'emp-3',
        locationId: 'loc-1',
        balance: 5,
      });

      // Approve should fail — fresh balance (5) < requested (10)
      const approveRes = await request(app.getHttpServer())
        .patch(`/time-off-requests/${createRes.body.id}/approve`)
        .expect(400);

      expect(approveRes.body.message).toContain('Insufficient balance');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  REJECTION FLOW
  // ═══════════════════════════════════════════════════════════════════════

  describe('Rejection Flow', () => {
    it('should reject a pending request with a reason', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-2',
          locationId: 'loc-1',
          startDate: '2027-11-01',
          endDate: '2027-11-01',
          days: 1,
        })
        .expect(201);

      const rejectRes = await request(app.getHttpServer())
        .patch(`/time-off-requests/${createRes.body.id}/reject`)
        .send({ reason: 'Team fully booked' })
        .expect(200);

      expect(rejectRes.body.status).toBe(RequestStatus.REJECTED);
      expect(rejectRes.body.rejectionReason).toBe('Team fully booked');
    });

    it('should require a reason for rejection', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-2',
          locationId: 'loc-1',
          startDate: '2027-12-01',
          endDate: '2027-12-01',
          days: 1,
        })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/time-off-requests/${createRes.body.id}/reject`)
        .send({})
        .expect(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  CANCELLATION FLOW
  // ═══════════════════════════════════════════════════════════════════════

  describe('Cancellation Flow', () => {
    it('should cancel a PENDING request', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-2',
          locationId: 'loc-1',
          startDate: '2028-01-01',
          endDate: '2028-01-01',
          days: 1,
        })
        .expect(201);

      const cancelRes = await request(app.getHttpServer())
        .patch(`/time-off-requests/${createRes.body.id}/cancel`)
        .expect(200);

      expect(cancelRes.body.status).toBe(RequestStatus.CANCELLED);
    });

    it('should not cancel a CONFIRMED request', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-2',
          locationId: 'loc-1',
          startDate: '2028-02-01',
          endDate: '2028-02-01',
          days: 1,
        })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/time-off-requests/${createRes.body.id}/approve`)
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/time-off-requests/${createRes.body.id}/cancel`)
        .expect(409);
    });

    it('should free up reserved balance when cancelling', async () => {
      // Use emp-4 which has 40 days and no pending requests
      const beforeRes = await request(app.getHttpServer())
        .get('/balances/emp-4/loc-1/available')
        .expect(200);

      const availBefore = beforeRes.body.available;

      const createRes = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-4',
          locationId: 'loc-1',
          startDate: '2028-03-01',
          endDate: '2028-03-02',
          days: 2,
        })
        .expect(201);

      // Available should have decreased
      const duringRes = await request(app.getHttpServer())
        .get('/balances/emp-4/loc-1/available')
        .expect(200);

      expect(duringRes.body.available).toBe(availBefore - 2);

      // Cancel it
      await request(app.getHttpServer())
        .patch(`/time-off-requests/${createRes.body.id}/cancel`)
        .expect(200);

      // Available should be restored
      const afterRes = await request(app.getHttpServer())
        .get('/balances/emp-4/loc-1/available')
        .expect(200);

      expect(afterRes.body.available).toBe(availBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  CONCURRENT REQUEST HANDLING
  // ═══════════════════════════════════════════════════════════════════════

  describe('Concurrent Request Handling', () => {
    it('should prevent over-deduction from multiple pending requests', async () => {
      // emp-new has 30 days, no prior requests
      const refreshRes = await request(app.getHttpServer())
        .get('/balances/emp-new/loc-1/refresh')
        .expect(200);
      expect(refreshRes.body.balance).toBe(30);

      // Create first request for 20 days (should succeed)
      await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-new',
          locationId: 'loc-1',
          startDate: '2027-07-01',
          endDate: '2027-07-20',
          days: 20,
        })
        .expect(201);

      // Create second request for 20 days (should fail — only 10 available)
      const res = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-new',
          locationId: 'loc-1',
          startDate: '2027-08-01',
          endDate: '2027-08-20',
          days: 20,
        })
        .expect(400);

      expect(res.body.message).toContain('Insufficient balance');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  IDEMPOTENCY
  // ═══════════════════════════════════════════════════════════════════════

  describe('Idempotency', () => {
    it('should generate unique idempotency keys per request', async () => {
      const res1 = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-4',
          locationId: 'loc-1',
          startDate: '2027-09-01',
          endDate: '2027-09-01',
          days: 1,
        })
        .expect(201);

      const res2 = await request(app.getHttpServer())
        .post('/time-off-requests')
        .send({
          employeeId: 'emp-4',
          locationId: 'loc-1',
          startDate: '2027-10-01',
          endDate: '2027-10-01',
          days: 1,
        })
        .expect(201);

      expect(res1.body.idempotencyKey).not.toBe(res2.body.idempotencyKey);
    });
  });
});
