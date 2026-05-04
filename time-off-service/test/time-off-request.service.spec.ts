import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { TimeOffRequestService } from '../src/time-off-request/time-off-request.service';
import { TimeOffRequest } from '../src/time-off-request/time-off-request.entity';
import { BalanceService } from '../src/balance/balance.service';
import { HcmService } from '../src/hcm/hcm.service';
import { RequestStatus } from '../src/common/enums';

describe('TimeOffRequestService (Unit)', () => {
  let service: TimeOffRequestService;
  let mockRequestRepo: any;
  let mockBalanceService: any;
  let mockHcmService: any;

  beforeEach(async () => {
    mockRequestRepo = {
      create: jest.fn((dto) => ({ ...dto, id: 'test-id' })),
      save: jest.fn((entity) => Promise.resolve({ ...entity })),
      findOne: jest.fn(),
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    mockBalanceService = {
      getAvailableBalance: jest.fn(),
      refreshBalance: jest.fn(),
      getReservedDays: jest.fn(),
      deductBalance: jest.fn(),
    };

    mockHcmService = {
      getBalance: jest.fn(),
      submitDeduction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeOffRequestService,
        {
          provide: getRepositoryToken(TimeOffRequest),
          useValue: mockRequestRepo,
        },
        { provide: BalanceService, useValue: mockBalanceService },
        { provide: HcmService, useValue: mockHcmService },
      ],
    }).compile();

    service = module.get<TimeOffRequestService>(TimeOffRequestService);
  });

  describe('create', () => {
    it('should create a request when balance is sufficient', async () => {
      mockBalanceService.getAvailableBalance.mockResolvedValue({
        total: 10,
        reserved: 0,
        available: 10,
      });

      const result = await service.create({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        startDate: '2027-06-01',
        endDate: '2027-06-02',
        days: 2,
      });

      expect(result.status).toBe(RequestStatus.PENDING);
      expect(result.idempotencyKey).toBeDefined();
      expect(mockRequestRepo.save).toHaveBeenCalled();
    });

    it('should throw BadRequest when balance is insufficient', async () => {
      mockBalanceService.getAvailableBalance.mockResolvedValue({
        total: 5,
        reserved: 3,
        available: 2,
      });

      await expect(
        service.create({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          startDate: '2027-06-01',
          endDate: '2027-06-05',
          days: 5,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw when startDate > endDate', async () => {
      await expect(
        service.create({
          employeeId: 'emp-1',
          locationId: 'loc-1',
          startDate: '2027-06-10',
          endDate: '2027-06-01',
          days: 2,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw when balance record does not exist', async () => {
      mockBalanceService.getAvailableBalance.mockRejectedValue(
        new NotFoundException('No balance found'),
      );

      await expect(
        service.create({
          employeeId: 'unknown',
          locationId: 'loc-1',
          startDate: '2027-06-01',
          endDate: '2027-06-02',
          days: 1,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('approve', () => {
    const pendingRequest = {
      id: 'req-1',
      employeeId: 'emp-1',
      locationId: 'loc-1',
      days: 2,
      status: RequestStatus.PENDING,
      idempotencyKey: 'key-1',
      startDate: '2027-06-01',
      endDate: '2027-06-02',
    };

    it('should confirm when HCM accepts deduction', async () => {
      mockRequestRepo.findOne.mockResolvedValue({ ...pendingRequest });
      mockBalanceService.refreshBalance.mockResolvedValue({ balance: 10 });
      mockBalanceService.getReservedDays.mockResolvedValue(2);
      mockHcmService.submitDeduction.mockResolvedValue({
        success: true,
        referenceId: 'HCM-REF-123',
      });
      mockBalanceService.deductBalance.mockResolvedValue({});

      const result = await service.approve('req-1');

      expect(result.status).toBe(RequestStatus.CONFIRMED);
      expect(result.hcmReferenceId).toBe('HCM-REF-123');
      expect(mockBalanceService.deductBalance).toHaveBeenCalledWith(
        'emp-1',
        'loc-1',
        2,
      );
    });

    it('should set HCM_REJECTED when HCM rejects', async () => {
      mockRequestRepo.findOne.mockResolvedValue({ ...pendingRequest });
      mockBalanceService.refreshBalance.mockResolvedValue({ balance: 10 });
      mockBalanceService.getReservedDays.mockResolvedValue(2);
      mockHcmService.submitDeduction.mockResolvedValue({
        success: false,
        error: 'Blackout period',
      });

      const result = await service.approve('req-1');

      expect(result.status).toBe(RequestStatus.HCM_REJECTED);
      expect(result.rejectionReason).toContain('Blackout period');
      expect(mockBalanceService.deductBalance).not.toHaveBeenCalled();
    });

    it('should handle HCM network failure gracefully', async () => {
      mockRequestRepo.findOne.mockResolvedValue({ ...pendingRequest });
      mockBalanceService.refreshBalance.mockResolvedValue({ balance: 10 });
      mockBalanceService.getReservedDays.mockResolvedValue(2);
      mockHcmService.submitDeduction.mockRejectedValue(
        new Error('Connection timeout'),
      );

      const result = await service.approve('req-1');

      expect(result.status).toBe(RequestStatus.HCM_REJECTED);
      expect(result.rejectionReason).toContain('Connection timeout');
    });

    it('should throw ConflictException for non-PENDING request', async () => {
      mockRequestRepo.findOne.mockResolvedValue({
        ...pendingRequest,
        status: RequestStatus.CONFIRMED,
      });

      await expect(service.approve('req-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw BadRequest when balance refresh fails', async () => {
      mockRequestRepo.findOne.mockResolvedValue({ ...pendingRequest });
      mockBalanceService.refreshBalance.mockRejectedValue(
        new Error('HCM down'),
      );

      await expect(service.approve('req-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequest when fresh balance is insufficient', async () => {
      mockRequestRepo.findOne.mockResolvedValue({ ...pendingRequest });
      mockBalanceService.refreshBalance.mockResolvedValue({ balance: 1 });
      mockBalanceService.getReservedDays.mockResolvedValue(2);

      await expect(service.approve('req-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('reject', () => {
    it('should reject a PENDING request with reason', async () => {
      mockRequestRepo.findOne.mockResolvedValue({
        id: 'req-1',
        status: RequestStatus.PENDING,
      });

      const result = await service.reject('req-1', 'No coverage');

      expect(result.status).toBe(RequestStatus.REJECTED);
      expect(result.rejectionReason).toBe('No coverage');
    });

    it('should throw ConflictException for non-PENDING request', async () => {
      mockRequestRepo.findOne.mockResolvedValue({
        id: 'req-1',
        status: RequestStatus.CONFIRMED,
      });

      await expect(service.reject('req-1', 'reason')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('cancel', () => {
    it('should cancel a PENDING request', async () => {
      mockRequestRepo.findOne.mockResolvedValue({
        id: 'req-1',
        status: RequestStatus.PENDING,
      });

      const result = await service.cancel('req-1');
      expect(result.status).toBe(RequestStatus.CANCELLED);
    });

    it('should throw ConflictException for CONFIRMED request', async () => {
      mockRequestRepo.findOne.mockResolvedValue({
        id: 'req-1',
        status: RequestStatus.CONFIRMED,
      });

      await expect(service.cancel('req-1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw ConflictException for HCM_REJECTED request', async () => {
      mockRequestRepo.findOne.mockResolvedValue({
        id: 'req-1',
        status: RequestStatus.HCM_REJECTED,
      });

      await expect(service.cancel('req-1')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('findById', () => {
    it('should throw NotFoundException for unknown ID', async () => {
      mockRequestRepo.findOne.mockResolvedValue(null);

      await expect(service.findById('unknown')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
