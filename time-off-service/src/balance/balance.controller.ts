import { Controller, Get, Post, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { BalanceService } from './balance.service';

@ApiTags('balances')
@Controller('balances')
export class BalanceController {
  constructor(private readonly balanceService: BalanceService) {}

  @Get(':employeeId')
  @ApiOperation({ summary: 'Get cached balances for an employee' })
  @ApiParam({ name: 'employeeId' })
  @ApiQuery({ name: 'locationId', required: false })
  @ApiQuery({ name: 'refresh', required: false, description: 'pass "true" to force HCM sync' })
  @ApiResponse({ status: 200 })
  async getBalances(
    @Param('employeeId') employeeId: string,
    @Query('locationId') locationId?: string,
    @Query('refresh') refresh?: string,
  ) {
    const shouldRefresh = refresh === 'true';
    const balances = await this.balanceService.getBalances(employeeId, locationId, shouldRefresh);

    return {
      employeeId,
      balances: balances.map((b) => ({
        id: b.id,
        locationId: b.locationId,
        balance: Number(b.balance),
        lastSyncedAt: b.lastSyncedAt,
        stale: !b.lastSyncedAt || this.isStale(b.lastSyncedAt),
      })),
    };
  }

  @Get(':employeeId/:locationId/refresh')
  @ApiOperation({ summary: 'Force sync a single balance from HCM' })
  @ApiParam({ name: 'employeeId' })
  @ApiParam({ name: 'locationId' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 503, description: 'HCM unavailable' })
  async refreshBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
  ) {
    const b = await this.balanceService.refreshBalance(employeeId, locationId);
    return {
      id: b.id,
      employeeId: b.employeeId,
      locationId: b.locationId,
      balance: Number(b.balance),
      lastSyncedAt: b.lastSyncedAt,
    };
  }

  @Get(':employeeId/:locationId/available')
  @ApiOperation({ summary: 'Get available balance (total minus in-flight requests)' })
  @ApiParam({ name: 'employeeId' })
  @ApiParam({ name: 'locationId' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'Balance record not found' })
  async getAvailableBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
  ) {
    return this.balanceService.getAvailableBalance(employeeId, locationId);
  }

  @Post('sync')
  @ApiOperation({ summary: 'Trigger a full batch sync from HCM' })
  @ApiResponse({ status: 201 })
  async triggerSync() {
    return this.balanceService.batchSync();
  }

  private isStale(lastSyncedAt: Date): boolean {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    return new Date(lastSyncedAt) < oneHourAgo;
  }
}
