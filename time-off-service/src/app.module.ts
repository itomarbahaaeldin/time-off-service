import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffBalance } from './balance/balance.entity';
import { TimeOffRequest } from './time-off-request/time-off-request.entity';
import { SyncLog } from './sync/sync-log.entity';
import { BalanceService } from './balance/balance.service';
import { BalanceController } from './balance/balance.controller';
import { TimeOffRequestService } from './time-off-request/time-off-request.service';
import { TimeOffRequestController } from './time-off-request/time-off-request.controller';
import { HcmService } from './hcm/hcm.service';
import { SyncService } from './sync/sync.service';
import { HomeController } from './home.controller';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: process.env.DB_PATH || 'timeoff.db',
      entities: [TimeOffBalance, TimeOffRequest, SyncLog],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([TimeOffBalance, TimeOffRequest, SyncLog]),
  ],
  controllers: [HomeController, BalanceController, TimeOffRequestController],
  providers: [BalanceService, TimeOffRequestService, HcmService, SyncService],
})
export class AppModule {}
