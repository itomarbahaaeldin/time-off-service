import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TimeOffBalance } from './balance.entity';
import { HcmService } from '../hcm/hcm.service';
import { SyncService } from '../sync/sync.service';
import { IN_FLIGHT_STATUSES } from '../common/enums';
import { TimeOffRequest } from '../time-off-request/time-off-request.entity';

const OPTIMISTIC_LOCK_RETRIES = 3;

@Injectable()
export class BalanceService {
  private readonly logger = new Logger(BalanceService.name);

  constructor(
    @InjectRepository(TimeOffBalance)
    private readonly balanceRepo: Repository<TimeOffBalance>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly hcmService: HcmService,
    private readonly syncService: SyncService,
  ) {}

  async getBalances(employeeId: string, locationId?: string, refresh = false) {
    if (refresh) {
      if (locationId) {
        await this.refreshBalance(employeeId, locationId).catch((err) =>
          this.logger.warn(`refresh failed for ${employeeId}/${locationId}: ${err.message}`),
        );
      } else {
        // refresh all known locations for this employee
        const rows = await this.balanceRepo.find({ where: { employeeId } });
        await Promise.allSettled(
          rows.map((b) =>
            this.refreshBalance(employeeId, b.locationId).catch((err) =>
              this.logger.warn(`refresh failed for ${employeeId}/${b.locationId}: ${err.message}`),
            ),
          ),
        );
      }
    }

    const where: any = { employeeId };
    if (locationId) where.locationId = locationId;

    return this.balanceRepo.find({ where });
  }

  async refreshBalance(employeeId: string, locationId: string): Promise<TimeOffBalance> {
    const hcmData = await this.hcmService.getBalance(employeeId, locationId);

    let record = await this.balanceRepo.findOne({ where: { employeeId, locationId } });

    if (record) {
      record.balance = hcmData.balance;
      record.lastSyncedAt = new Date();
    } else {
      record = this.balanceRepo.create({
        employeeId,
        locationId,
        balance: hcmData.balance,
        lastSyncedAt: new Date(),
      });
    }

    return this.balanceRepo.save(record);
  }

  async batchSync() {
    return this.syncService.executeBatchSync();
  }

  async getAvailableBalance(employeeId: string, locationId: string) {
    const record = await this.balanceRepo.findOne({ where: { employeeId, locationId } });

    if (!record) {
      throw new NotFoundException(`No balance found for employee=${employeeId}, location=${locationId}`);
    }

    const reserved = await this.getReservedDays(employeeId, locationId);
    const available = Number(record.balance) - reserved;

    return {
      total: Number(record.balance),
      reserved,
      available: Math.max(0, available),
    };
  }

  async getReservedDays(employeeId: string, locationId: string): Promise<number> {
    const res = await this.requestRepo
      .createQueryBuilder('req')
      .select('COALESCE(SUM(req.days), 0)', 'total')
      .where('req.employeeId = :employeeId', { employeeId })
      .andWhere('req.locationId = :locationId', { locationId })
      .andWhere('req.status IN (:...statuses)', { statuses: IN_FLIGHT_STATUSES })
      .getRawOne();

    return parseFloat(res?.total || '0');
  }

  // uses optimistic locking + retry to handle concurrent requests (C5 in TRD)
  async deductBalance(employeeId: string, locationId: string, days: number): Promise<TimeOffBalance> {
    let attempt = 0;

    while (attempt < OPTIMISTIC_LOCK_RETRIES) {
      attempt++;

      const record = await this.balanceRepo.findOne({ where: { employeeId, locationId } });

      if (!record) {
        throw new NotFoundException(`No balance found for employee=${employeeId}, location=${locationId}`);
      }

      try {
        record.balance = Number(record.balance) - days;
        return await this.balanceRepo.save(record);
      } catch (err: any) {
        const isVersionConflict =
          err?.name === 'OptimisticLockVersionMismatchError' ||
          err?.message?.includes('optimistic lock');

        if (isVersionConflict && attempt < OPTIMISTIC_LOCK_RETRIES) {
          this.logger.warn(
            `optimistic lock conflict for ${employeeId}/${locationId}, retrying (${attempt}/${OPTIMISTIC_LOCK_RETRIES})`,
          );
          await new Promise((r) => setTimeout(r, 50 * attempt));
          continue;
        }

        if (isVersionConflict) {
          throw new ConflictException(`Balance update failed after ${OPTIMISTIC_LOCK_RETRIES} retries due to concurrent writes`);
        }

        throw err;
      }
    }

    throw new ConflictException('Balance update failed due to concurrent modifications');
  }
}
