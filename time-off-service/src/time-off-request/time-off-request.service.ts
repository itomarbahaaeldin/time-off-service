import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { TimeOffRequest } from './time-off-request.entity';
import { CreateTimeOffRequestDto } from './dto/time-off-request.dto';
import { BalanceService } from '../balance/balance.service';
import { HcmService } from '../hcm/hcm.service';
import { RequestStatus } from '../common/enums';

@Injectable()
export class TimeOffRequestService {
  private readonly logger = new Logger(TimeOffRequestService.name);

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly balanceService: BalanceService,
    private readonly hcmService: HcmService,
  ) {}

  async create(dto: CreateTimeOffRequestDto): Promise<TimeOffRequest> {
    if (dto.startDate > dto.endDate) {
      throw new BadRequestException('startDate must be before or equal to endDate');
    }

    const start = new Date(dto.startDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (start < today) {
      throw new BadRequestException('startDate cannot be in the past');
    }

    // local balance check before we bother HCM
    try {
      const { available } = await this.balanceService.getAvailableBalance(
        dto.employeeId,
        dto.locationId,
      );
      if (dto.days > available) {
        throw new BadRequestException(
          `Insufficient balance: requested ${dto.days} days but only ${available} available`,
        );
      }
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw new BadRequestException(
          `No balance record found for employee=${dto.employeeId}, location=${dto.locationId}. Sync first.`,
        );
      }
      throw err;
    }

    const req = this.requestRepo.create({
      ...dto,
      status: RequestStatus.PENDING,
      idempotencyKey: uuidv4(),
    });

    return this.requestRepo.save(req);
  }

  async findById(id: string): Promise<TimeOffRequest> {
    const req = await this.requestRepo.findOne({ where: { id } });
    if (!req) throw new NotFoundException(`Request ${id} not found`);
    return req;
  }

  async findAll(filters: {
    employeeId?: string;
    status?: RequestStatus;
    locationId?: string;
  }): Promise<TimeOffRequest[]> {
    const where: Record<string, unknown> = {};
    if (filters.employeeId) where.employeeId = filters.employeeId;
    if (filters.status) where.status = filters.status;
    if (filters.locationId) where.locationId = filters.locationId;

    return this.requestRepo.find({ where, order: { createdAt: 'DESC' } });
  }

  async approve(id: string): Promise<TimeOffRequest> {
    const req = await this.findById(id);

    if (req.status !== RequestStatus.PENDING) {
      throw new ConflictException(`Can't approve a request in status ${req.status}`);
    }

    // re-fetch fresh balance from HCM before we commit anything
    let freshBalance: number;
    try {
      const refreshed = await this.balanceService.refreshBalance(req.employeeId, req.locationId);
      freshBalance = Number(refreshed.balance);
    } catch (err) {
      this.logger.error(`HCM balance refresh failed: ${err.message}`);
      throw new BadRequestException('Could not verify balance with HCM right now, try again later');
    }

    // re-validate with fresh numbers, excluding this request from reserved
    const reserved = await this.balanceService.getReservedDays(req.employeeId, req.locationId);
    const availableExcludingThis = freshBalance - (reserved - Number(req.days));

    if (Number(req.days) > availableExcludingThis) {
      throw new BadRequestException(
        `Insufficient balance after HCM refresh: requested ${req.days} days but only ${availableExcludingThis} available`,
      );
    }

    req.status = RequestStatus.SUBMITTED_TO_HCM;
    await this.requestRepo.save(req);

    try {
      const hcmRes = await this.hcmService.submitDeduction({
        employeeId: req.employeeId,
        locationId: req.locationId,
        days: Number(req.days),
        idempotencyKey: req.idempotencyKey,
        startDate: req.startDate,
        endDate: req.endDate,
      });

      if (hcmRes.success) {
        req.status = RequestStatus.CONFIRMED;
        req.hcmReferenceId = hcmRes.referenceId ?? null;
        await this.balanceService.deductBalance(req.employeeId, req.locationId, Number(req.days));
      } else {
        req.status = RequestStatus.HCM_REJECTED;
        req.rejectionReason = hcmRes.error || 'Rejected by HCM';
      }
    } catch (err) {
      this.logger.error(`HCM submission error: ${err.message}`);
      req.status = RequestStatus.HCM_REJECTED;
      req.rejectionReason = `HCM error: ${err.message}`;
    }

    return this.requestRepo.save(req);
  }

  async reject(id: string, reason: string): Promise<TimeOffRequest> {
    const req = await this.findById(id);

    if (req.status !== RequestStatus.PENDING) {
      throw new ConflictException(`Can't reject a request in status ${req.status}`);
    }

    req.status = RequestStatus.REJECTED;
    req.rejectionReason = reason;
    return this.requestRepo.save(req);
  }

  async cancel(id: string): Promise<TimeOffRequest> {
    const req = await this.findById(id);

    if (req.status !== RequestStatus.PENDING && req.status !== RequestStatus.APPROVED) {
      throw new ConflictException(
        `Can't cancel a request in status ${req.status} — only PENDING or APPROVED can be cancelled`,
      );
    }

    req.status = RequestStatus.CANCELLED;
    return this.requestRepo.save(req);
  }
}
