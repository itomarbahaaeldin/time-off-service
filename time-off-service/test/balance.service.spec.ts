import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { BalanceService } from '../src/balance/balance.service';
import { TimeOffBalance } from '../src/balance/balance.entity';
import { TimeOffRequest } from '../src/time-off-request/time-off-request.entity';
import { HcmService } from '../src/hcm/hcm.service';
import { SyncService } from '../src/sync/sync.service';

describe('BalanceService (Unit)', () => {
  let service: BalanceService;
  let mockBalanceRepo: any;
  let mockRequestRepo: any;
  let mockHcmService: any;
  let mockSyncService: any;

  const makeBalance = (overrides = {}) => ({
    id: 'b1',
    employeeId: 'emp-1',
    locationId: 'loc-1',
    balance: 10,
    lastSyncedAt: new Date(),
    version: 1,
    ...overrides,
  });

  beforeEach(async () => {
    mockBalanceRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn((e) => Promise.resolve({ ...e })),
      create: jest.fn((e) => ({ ...e })),
    };

    mockRequestRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ total: 0 }),
      }),
    };

    mockHcmService = {
      getBalance: jest.fn(),
    };

    mockSyncService = {
      executeBatchSync: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceService,
        { provide: getRepositoryToken(TimeOffBalance), useValue: mockBalanceRepo },
        { provide: getRepositoryToken(TimeOffRequest), useValue: mockRequestRepo },
        { provide: HcmService, useValue: mockHcmService },
        { provide: SyncService, useValue: mockSyncService },
      ],
    }).compile();

    service = module.get<BalanceService>(BalanceService);
  });

  // ─── getBalances ──────────────────────────────────────────────────────

  describe('getBalances', () => {
    it('should return cached balances without refresh', async () => {
      mockBalanceRepo.find.mockResolvedValue([makeBalance()]);
      const result = await service.getBalances('emp-1');
      expect(mockHcmService.getBalance).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    it('should refresh specific location when refresh=true and locationId given', async () => {
      mockHcmService.getBalance.mockResolvedValue({ employeeId: 'emp-1', locationId: 'loc-1', balance: 12 });
      mockBalanceRepo.findOne.mockResolvedValue(makeBalance());
      mockBalanceRepo.find.mockResolvedValue([makeBalance()]);

      await service.getBalances('emp-1', 'loc-1', true);
      expect(mockHcmService.getBalance).toHaveBeenCalledWith('emp-1', 'loc-1');
    });

    it('should refresh ALL locations when refresh=true and no locationId given', async () => {
      // Employee has 2 locations
      const balances = [
        makeBalance({ locationId: 'loc-1' }),
        makeBalance({ locationId: 'loc-2' }),
      ];
      mockBalanceRepo.find.mockResolvedValue(balances);
      mockHcmService.getBalance.mockResolvedValue({ employeeId: 'emp-1', locationId: 'loc-1', balance: 10 });
      mockBalanceRepo.findOne.mockResolvedValue(makeBalance());

      await service.getBalances('emp-1', undefined, true);
      // Should call HCM once per location
      expect(mockHcmService.getBalance).toHaveBeenCalledTimes(2);
    });

    it('should continue if refresh fails for one location', async () => {
      mockBalanceRepo.find.mockResolvedValue([
        makeBalance({ locationId: 'loc-1' }),
        makeBalance({ locationId: 'loc-2' }),
      ]);
      // First location fails, second succeeds
      mockHcmService.getBalance
        .mockRejectedValueOnce(new Error('HCM down'))
        .mockResolvedValueOnce({ employeeId: 'emp-1', locationId: 'loc-2', balance: 5 });
      mockBalanceRepo.findOne.mockResolvedValue(makeBalance());

      // Should not throw — partial refresh is OK
      await expect(service.getBalances('emp-1', undefined, true)).resolves.not.toThrow();
    });
  });

  // ─── refreshBalance ───────────────────────────────────────────────────

  describe('refreshBalance', () => {
    it('should update existing balance record from HCM', async () => {
      const existing = makeBalance({ balance: 10 });
      mockHcmService.getBalance.mockResolvedValue({ employeeId: 'emp-1', locationId: 'loc-1', balance: 15 });
      mockBalanceRepo.findOne.mockResolvedValue(existing);

      const result = await service.refreshBalance('emp-1', 'loc-1');
      expect(mockBalanceRepo.save).toHaveBeenCalled();
      expect(result.balance).toBe(15);
    });

    it('should create a new balance record if none exists', async () => {
      mockHcmService.getBalance.mockResolvedValue({ employeeId: 'emp-1', locationId: 'loc-1', balance: 8 });
      mockBalanceRepo.findOne.mockResolvedValue(null);
      mockBalanceRepo.create.mockReturnValue({ employeeId: 'emp-1', locationId: 'loc-1', balance: 8 });

      await service.refreshBalance('emp-1', 'loc-1');
      expect(mockBalanceRepo.create).toHaveBeenCalled();
      expect(mockBalanceRepo.save).toHaveBeenCalled();
    });
  });

  // ─── getAvailableBalance ──────────────────────────────────────────────

  describe('getAvailableBalance', () => {
    it('should return total, reserved and available correctly', async () => {
      mockBalanceRepo.findOne.mockResolvedValue(makeBalance({ balance: 10 }));
      mockRequestRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ total: '3' }),
      });

      const result = await service.getAvailableBalance('emp-1', 'loc-1');
      expect(result.total).toBe(10);
      expect(result.reserved).toBe(3);
      expect(result.available).toBe(7);
    });

    it('should return 0 available when reserved exceeds total', async () => {
      mockBalanceRepo.findOne.mockResolvedValue(makeBalance({ balance: 2 }));
      mockRequestRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ total: '5' }),
      });

      const result = await service.getAvailableBalance('emp-1', 'loc-1');
      expect(result.available).toBe(0);
    });

    it('should throw NotFoundException when no balance record exists', async () => {
      mockBalanceRepo.findOne.mockResolvedValue(null);
      await expect(service.getAvailableBalance('emp-1', 'loc-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── deductBalance (optimistic lock) ─────────────────────────────────

  describe('deductBalance (optimistic lock)', () => {
    it('should deduct balance on first attempt', async () => {
      const balance = makeBalance({ balance: 10 });
      mockBalanceRepo.findOne.mockResolvedValue(balance);
      mockBalanceRepo.save.mockResolvedValue({ ...balance, balance: 8 });

      const result = await service.deductBalance('emp-1', 'loc-1', 2);
      expect(result.balance).toBe(8);
    });

    it('should retry on optimistic lock conflict and succeed on second attempt', async () => {
      const balance = makeBalance({ balance: 10 });
      mockBalanceRepo.findOne.mockResolvedValue(balance);

      const lockError = new Error('optimistic lock conflict detected');
      lockError.name = 'OptimisticLockVersionMismatchError';

      mockBalanceRepo.save
        .mockRejectedValueOnce(lockError)
        .mockResolvedValueOnce({ ...balance, balance: 8 });

      const result = await service.deductBalance('emp-1', 'loc-1', 2);
      expect(mockBalanceRepo.save).toHaveBeenCalledTimes(2);
      expect(result.balance).toBe(8);
    });

    it('should throw ConflictException after max retries exhausted', async () => {
      const balance = makeBalance({ balance: 10 });
      mockBalanceRepo.findOne.mockResolvedValue(balance);

      const lockError = new Error('optimistic lock conflict detected');
      lockError.name = 'OptimisticLockVersionMismatchError';

      mockBalanceRepo.save.mockRejectedValue(lockError);

      await expect(service.deductBalance('emp-1', 'loc-1', 2)).rejects.toThrow(ConflictException);
      expect(mockBalanceRepo.save).toHaveBeenCalledTimes(3); // OPTIMISTIC_LOCK_RETRIES = 3
    });

    it('should throw NotFoundException if balance record is missing', async () => {
      mockBalanceRepo.findOne.mockResolvedValue(null);
      await expect(service.deductBalance('emp-1', 'loc-1', 2)).rejects.toThrow(NotFoundException);
    });

    it('should re-throw non-lock errors immediately', async () => {
      const balance = makeBalance({ balance: 10 });
      mockBalanceRepo.findOne.mockResolvedValue(balance);
      mockBalanceRepo.save.mockRejectedValue(new Error('disk full'));

      await expect(service.deductBalance('emp-1', 'loc-1', 2)).rejects.toThrow('disk full');
      expect(mockBalanceRepo.save).toHaveBeenCalledTimes(1); // no retry for non-lock errors
    });
  });

  // ─── batchSync ────────────────────────────────────────────────────────

  describe('batchSync', () => {
    it('should delegate to syncService.executeBatchSync', async () => {
      mockSyncService.executeBatchSync.mockResolvedValue({ recordsProcessed: 5, recordsUpdated: 2, errors: [] });
      const result = await service.batchSync();
      expect(mockSyncService.executeBatchSync).toHaveBeenCalled();
      expect(result.recordsProcessed).toBe(5);
    });
  });
});
