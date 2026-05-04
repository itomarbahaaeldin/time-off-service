export enum RequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  SUBMITTED_TO_HCM = 'SUBMITTED_TO_HCM',
  CONFIRMED = 'CONFIRMED',
  HCM_REJECTED = 'HCM_REJECTED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

export enum SyncType {
  BATCH = 'BATCH',
  REALTIME = 'REALTIME',
  ON_DEMAND = 'ON_DEMAND',
}

export enum SyncStatus {
  SUCCESS = 'SUCCESS',
  PARTIAL_FAILURE = 'PARTIAL_FAILURE',
  FAILURE = 'FAILURE',
}

/**
 * Statuses that indicate a request is "in-flight" and has reserved balance.
 */
export const IN_FLIGHT_STATUSES = [
  RequestStatus.PENDING,
  RequestStatus.APPROVED,
  RequestStatus.SUBMITTED_TO_HCM,
];
