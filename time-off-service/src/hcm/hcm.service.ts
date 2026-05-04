import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

export interface HcmBalanceResponse {
  employeeId: string;
  locationId: string;
  balance: number;
}

export interface HcmDeductionRequest {
  employeeId: string;
  locationId: string;
  days: number;
  idempotencyKey: string;
  startDate: string;
  endDate: string;
}

export interface HcmDeductionResponse {
  success: boolean;
  referenceId?: string;
  error?: string;
}

export interface HcmBatchBalanceResponse {
  balances: HcmBalanceResponse[];
}

@Injectable()
export class HcmService {
  private readonly logger = new Logger(HcmService.name);
  private readonly client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: process.env.HCM_BASE_URL || 'http://localhost:4000',
      timeout: 10000,
    });
  }

  async getBalance(employeeId: string, locationId: string): Promise<HcmBalanceResponse> {
    this.logger.log(`fetching balance: employee=${employeeId}, location=${locationId}`);
    const res = await this.client.get<HcmBalanceResponse>(`/api/balances/${employeeId}/${locationId}`);
    return res.data;
  }

  async submitDeduction(req: HcmDeductionRequest): Promise<HcmDeductionResponse> {
    this.logger.log(`submitting deduction: employee=${req.employeeId}, days=${req.days}`);
    const res = await this.client.post<HcmDeductionResponse>('/api/deductions', req);
    return res.data;
  }

  async getBatchBalances(): Promise<HcmBatchBalanceResponse> {
    this.logger.log('fetching batch balances');
    const res = await this.client.get<HcmBatchBalanceResponse>('/api/balances/batch');
    return res.data;
  }
}
