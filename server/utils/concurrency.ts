/** Map values with bounded parallelism while retaining the original order. */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];

  const output = new Array<R>(values.length);
  const workerCount = Math.min(values.length, Math.max(1, Math.floor(concurrency)));
  let cursor = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}
