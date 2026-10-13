/**
 * Coalesces interval ticks while the previous asynchronous run is still in
 * progress. This keeps slow provider or database calls from overlapping.
 */
export function createNonOverlappingRunner(task: () => Promise<void>) {
  let running = false;

  return async (): Promise<boolean> => {
    if (running) return false;

    running = true;
    try {
      await task();
      return true;
    } finally {
      running = false;
    }
  };
}
