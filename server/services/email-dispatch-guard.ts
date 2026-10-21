import { ScheduledJobLeaseLostError, type ScheduledJobContext } from '../scheduledJobRuntime';
import { areNotificationsEnabled } from './notificationPolicy';

/** Only raised before the irreversible mail-provider call has begun. */
export class EmailDispatchNotStartedError extends Error {
  constructor() {
    super('Email eligibility could not be confirmed before dispatch; no email was sent.');
    this.name = 'EmailDispatchNotStartedError';
  }
}

export async function assertEmailDispatchAllowed(beforeDispatch?: () => Promise<boolean>, context?: ScheduledJobContext): Promise<void> {
  if (context?.signal.aborted) throw new ScheduledJobLeaseLostError();
  if (!areNotificationsEnabled()) throw new EmailDispatchNotStartedError();
  try {
    if (beforeDispatch && await beforeDispatch() !== true) throw new EmailDispatchNotStartedError();
  } catch (error) {
    if (error instanceof ScheduledJobLeaseLostError) throw error;
    if (context?.signal.aborted) throw new ScheduledJobLeaseLostError();
    throw new EmailDispatchNotStartedError();
  }
  if (context?.signal.aborted) throw new ScheduledJobLeaseLostError();
  if (!areNotificationsEnabled()) throw new EmailDispatchNotStartedError();
}
