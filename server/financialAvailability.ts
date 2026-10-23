import { TRPCError } from '@trpc/server';
import { FINANCIAL_PAUSED_MESSAGE } from '../shared/financialAvailability';

export function financialFeaturesEnabled(): boolean {
  const value = process.env.FINANCIAL_FEATURES_ENABLED;
  if (value !== undefined) return value === 'true';
  return process.env.NODE_ENV !== 'production';
}

export function assertFinancialFeaturesEnabled(): void {
  if (!financialFeaturesEnabled()) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: FINANCIAL_PAUSED_MESSAGE });
  }
}
