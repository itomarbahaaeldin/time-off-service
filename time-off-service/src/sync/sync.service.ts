import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { TimeOffBalance } from '../balance/balance.entity';
import { SyncLog } from './sync-log.entity';
import { HcmService } from '../hcm/hcm.service';
import { TimeOffRequest } from '../time-off-request/time-off-request.entity';
import { SyncType, SyncStatus, RequestStatus, IN_FLIGHT_STATUSES } from '../common/enums';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectRepository(TimeOffBalance)
    private readonly balanceRepo: Repository<TimeOffBalance>,
    @InjectRepository(SyncLog)
    private readonly syncLogRepo: Repository<SyncLog>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly hcmService: HcmService,
  ) {}

  async executeBatchSync() {
    const log = this.syncLogRepo.create({
      syncType: SyncType.BATCH,
      status: SyncStatus.SUCCESS,
      recordsProcessed: 0,
      recordsUpdated: 0,
    });
    await this.syncLogRepo.save(log);

    const errors: string[] = [];
    let processed = 0;
    let updated = 0;

    try {
      const { balances } = await this.hcmService.getBatchBalances();
      const now = new Date();

      for (const hcm of balances) {
        processed++;
        try {
          let local = await this.balanceRepo.findOne({
            where: { employeeId: hcm.employeeId, locationId: hcm.locationId },
          });

          if (local) {
            const localVal = Number(local.balance);
            const hcmVal = Number(hcm.balance);

            if (localVal !== hcmVal) {
              this.logger.log(
                `drift: employee=${hcm.employeeId} location=${hcm.locationId} local=${localVal} hcm=${hcmVal}`,
              );
              local.balance = hcmVal;
              local.lastSyncedAt = now;
              await this.balanceRepo.save(local);
              updated++;

              // flag any in-flight requests that now exceed the updated balance
              await this.flagOverBalance(hcm.employeeId, hcm.locationId, hcmVal, errors);
            } else {
              local.lastSyncedAt = now;
              await this.balanceRepo.save(local);
            }
          } else {
            local = this.balanceRepo.create({
              employeeId: hcm.employeeId,
              locationId: hcm.locationId,
              balance: hcm.balance,
              lastSyncedAt: now,
            });
            await this.balanceRepo.save(local);
            updated++;
          }
        } catch (err) {
          const msg = `failed to sync employee=${hcm.employeeId} location=${hcm.locationId}: ${err.message}`;
          this.logger.error(msg);
          errors.push(msg);
        }
      }

      log.recordsProcessed = processed;
      log.recordsUpdated = updated;
      log.status = errors.length > 0 ? SyncStatus.PARTIAL_FAILURE : SyncStatus.SUCCESS;
      log.errors = errors.length > 0 ? JSON.stringify(errors) : null;
      log.completedAt = new Date();
      await this.syncLogRepo.save(log);
    } catch (err) {
      this.logger.error(`batch sync failed: ${err.message}`);
      log.status = SyncStatus.FAILURE;
      log.errors = JSON.stringify([err.message]);
      log.completedAt = new Date();
      await this.syncLogRepo.save(log);
      errors.push(err.message);
    }

    return { recordsProcessed: processed, recordsUpdated: updated, errors };
  }

  // when balance drops due to HCM drift, warn managers about in-flight requests
  // that might now be over-budget. we don't auto-cancel — manager already approved.
  private async flagOverBalance(
    employeeId: string,
    locationId: string,
    newBalance: number,
    errors: string[],
  ) {
    try {
      const inFlight = await this.requestRepo.find({
        where: {
          employeeId,
          locationId,
          status: In([RequestStatus.PENDING, RequestStatus.APPROVED]),
        },
        order: { createdAt: 'ASC' },
      });

      if (!inFlight.length) return;

      let running = 0;
      for (const req of inFlight) {
        running += Number(req.days);
        if (running > newBalance && !req.rejectionReason?.includes('balance drift')) {
          req.rejectionReason =
            `⚠ balance drift: HCM updated balance to ${newBalance} days. ` +
            `This request (${req.days} days) may now exceed available balance — manager review needed.`;
          await this.requestRepo.save(req);
          this.logger.warn(`flagged request ${req.id} — over balance after HCM drift`);
        }
      }
    } catch (err) {
      errors.push(`flagOverBalance failed for ${employeeId}/${locationId}: ${err.message}`);
    }
  }
}
