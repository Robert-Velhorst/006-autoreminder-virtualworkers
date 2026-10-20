type HttpError = {
  data?: {
    httpStatus?: unknown;
  };
};

function getHttpStatus(error: unknown): number | null {
  const status = (error as HttpError | null)?.data?.httpStatus;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

/** Retry only failures that could recover without repeating a user action. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = getHttpStatus(error);
  if (status !== null && status >= 400 && status < 500) return false;
  return failureCount < 1;
}
