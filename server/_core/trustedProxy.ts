const DEFAULT_TRUSTED_PROXY_HOPS = 1;
const MAX_TRUSTED_PROXY_HOPS = 5;

export function getTrustedProxyHops(
  env: { TRUST_PROXY_HOPS?: string } = process.env as { TRUST_PROXY_HOPS?: string },
): number {
  const parsed = Number.parseInt(env.TRUST_PROXY_HOPS ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_TRUSTED_PROXY_HOPS
    ? parsed
    : DEFAULT_TRUSTED_PROXY_HOPS;
}
