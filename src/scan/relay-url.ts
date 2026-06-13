import { AppError } from "../errors";

/** True for IPv4 literals in loopback/private/link-local/CGNAT/reserved ranges. */
function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = [m[1], m[2], m[3], m[4]].map(Number);
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) // 192.168/16
  );
}

/** True for IPv6 literals (with or without brackets) in loopback/ULA/link-local. */
function isPrivateIPv6(host: string): boolean {
  let h = host;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  h = h.toLowerCase();
  if (h === "::1" || h === "::") return true;
  if (/^f[cd]/.test(h)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return true;
  }
  return isPrivateIPv4(h) || isPrivateIPv6(hostname);
}

/**
 * SSRF guard for the caller-supplied relay webhook. Requires a public HTTPS URL
 * with no embedded credentials, and rejects IP literals in loopback / private /
 * link-local ranges (incl. 169.254.169.254 cloud metadata).
 *
 * Not covered here: a hostname that *DNS-resolves* to a private IP (rebinding).
 * Workers can't resolve DNS at validation time, so the production relay
 * must also resolve-and-check at fetch time and/or use a per-tenant host
 * allowlist. Delivery sets `redirect: "manual"` so 3xx can't bypass this check.
 */
export function assertSafeRelayUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("bad_request", "`relay.url` must be a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new AppError("bad_request", "`relay.url` must be an HTTPS URL.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new AppError("bad_request", "`relay.url` must not contain credentials.");
  }
  if (isBlockedHost(url.hostname)) {
    throw new AppError(
      "bad_request",
      "`relay.url` must be a public host (loopback, private, and link-local addresses are not allowed).",
    );
  }
}
