/* eslint-disable @typescript-eslint/no-var-requires */
const express = require('express');
import { Server } from 'http';

/**
 * Mock HCM Server
 *
 * A configurable mock server that simulates the HCM system's API.
 * Supports:
 *  - Real-time balance lookups
 *  - Deduction submissions (with validation)
 *  - Batch balance endpoint
 *  - Configurable failure modes for testing resilience
 */

export interface MockHcmBalance {
  employeeId: string;
  locationId: string;
  balance: number;
}

export interface MockHcmConfig {
  /** Simulated balances stored in the mock HCM */
  balances: Map<string, MockHcmBalance>;

  /** If true, the deduction endpoint returns an error */
  rejectDeductions: boolean;

  /** If set, the deduction endpoint will use this custom error message */
  deductionErrorMessage?: string;

  /** If true, the balance endpoint returns 500 */
  simulateBalanceFailure: boolean;

  /** If true, the batch endpoint returns 500 */
  simulateBatchFailure: boolean;

  /** Track submitted deductions for assertions */
  submittedDeductions: Array<{
    employeeId: string;
    locationId: string;
    days: number;
    idempotencyKey: string;
  }>;

  /** Set of idempotency keys already processed (for idempotency testing) */
  processedIdempotencyKeys: Set<string>;
}

function balanceKey(employeeId: string, locationId: string): string {
  return `${employeeId}:${locationId}`;
}

export function createMockHcmConfig(
  initialBalances: MockHcmBalance[] = [],
): MockHcmConfig {
  const balances = new Map<string, MockHcmBalance>();
  for (const b of initialBalances) {
    balances.set(balanceKey(b.employeeId, b.locationId), b);
  }
  return {
    balances,
    rejectDeductions: false,
    deductionErrorMessage: undefined,
    simulateBalanceFailure: false,
    simulateBatchFailure: false,
    submittedDeductions: [],
    processedIdempotencyKeys: new Set(),
  };
}

export function createMockHcmApp(config: MockHcmConfig): any {
  const app = express();
  app.use(express.json());

  // GET /api/balances/:employeeId/:locationId — Real-time balance lookup
  app.get('/api/balances/:employeeId/:locationId', (req, res) => {
    if (config.simulateBalanceFailure) {
      return res.status(500).json({ error: 'HCM internal error' });
    }

    const key = balanceKey(req.params.employeeId, req.params.locationId);
    const balance = config.balances.get(key);

    if (!balance) {
      return res.status(404).json({
        error: `No balance found for employee=${req.params.employeeId}, location=${req.params.locationId}`,
      });
    }

    return res.json({
      employeeId: balance.employeeId,
      locationId: balance.locationId,
      balance: balance.balance,
    });
  });

  // GET /api/balances/batch — Batch balance endpoint
  app.get('/api/balances/batch', (_req, res) => {
    if (config.simulateBatchFailure) {
      return res.status(500).json({ error: 'HCM batch endpoint error' });
    }

    const balances = Array.from(config.balances.values());
    return res.json({ balances });
  });

  // POST /api/deductions — Submit a time-off deduction
  app.post('/api/deductions', (req, res) => {
    const { employeeId, locationId, days, idempotencyKey } = req.body;

    // Idempotency check — if we already processed this key, return success
    if (config.processedIdempotencyKeys.has(idempotencyKey)) {
      return res.json({
        success: true,
        referenceId: `HCM-DUP-${idempotencyKey}`,
      });
    }

    if (config.rejectDeductions) {
      return res.json({
        success: false,
        error: config.deductionErrorMessage || 'Deduction rejected by HCM',
      });
    }

    const key = balanceKey(employeeId, locationId);
    const balance = config.balances.get(key);

    if (!balance) {
      return res.json({
        success: false,
        error: `Invalid dimension: employee=${employeeId}, location=${locationId}`,
      });
    }

    if (balance.balance < days) {
      return res.json({
        success: false,
        error: `Insufficient balance: has ${balance.balance}, requested ${days}`,
      });
    }

    // Deduct in mock HCM
    balance.balance -= days;
    config.balances.set(key, balance);

    config.submittedDeductions.push({
      employeeId,
      locationId,
      days,
      idempotencyKey,
    });
    config.processedIdempotencyKeys.add(idempotencyKey);

    return res.json({
      success: true,
      referenceId: `HCM-REF-${Date.now()}`,
    });
  });

  return app;
}

/**
 * Start the mock HCM server on the given port.
 */
export function startMockHcmServer(
  config: MockHcmConfig,
  port = 4000,
): Promise<Server> {
  const app = createMockHcmApp(config);
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      resolve(server);
    });
  });
}

/**
 * Stop the mock HCM server.
 */
export function stopMockHcmServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
