import type { ReactNode } from 'react';
import { trpc } from '@/lib/trpc';
import { FINANCIAL_PAUSED_MESSAGE } from '@shared/financialAvailability';

export function FinancialFeatureGate({ children }: { children: ReactNode }) {
  const availability = trpc.payment.availability.useQuery(undefined, {
    staleTime: 0,
    refetchInterval: 30_000,
    retry: false,
  });
  // A background refresh retains the last verified positive result and form state.
  if (!availability.isSuccess || availability.fetchStatus === 'paused' || availability.data?.enabled !== true) {
    return (
      <section role="status" className="border-l-2 border-muted-foreground p-4">
        <h2 className="text-sm font-semibold">Pay and payments paused</h2>
        <p className="mt-1 text-sm text-muted-foreground">{FINANCIAL_PAUSED_MESSAGE}</p>
      </section>
    );
  }
  return <>{children}</>;
}
