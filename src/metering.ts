/**
 * Per-scan usage metering — the NO-DATABASE fallback: an in-memory counter keyed
 * by API key. Used only when no control plane is configured (the unit suite, a bare
 * local Worker); a consumer that injects a control-plane adapter reserves a credit
 * at the gate and settles each scan to its own durable store instead.
 *
 * WARNING — this stub is unreliable even within a single deployment: Workers run
 * across multiple isolates, each with its own memory, so concurrent requests can
 * hit different counters (and all reset on eviction). It never enforces a balance.
 */
const counts = new Map<string, number>();

export function meterScan(apiKey: string): void {
  counts.set(apiKey, (counts.get(apiKey) ?? 0) + 1);
}
