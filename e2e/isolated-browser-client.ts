export function isolatedBrowserClientAddress(workerIndex: number, sequence: number) {
  if (!Number.isInteger(workerIndex) || workerIndex < 0 || workerIndex >= 128 ||
      !Number.isInteger(sequence) || sequence < 1 || sequence >= 1024) {
    throw new Error("Browser client identity is outside the isolated fixture range");
  }
  const index = workerIndex * 1024 + sequence;
  return `198.${18 + (index >>> 16)}.${(index >>> 8) & 255}.${index & 255}`;
}
