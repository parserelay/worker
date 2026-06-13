import { describe, expect, it } from "vitest";
import { assertSafeRelayUrl } from "./relay-url";

const blocked = [
  "https://169.254.169.254/latest/meta-data", // cloud metadata
  "https://127.0.0.1/hook", // loopback
  "https://10.0.0.5/hook", // private
  "https://192.168.1.1/hook", // private
  "https://172.16.0.1/hook", // private
  "https://100.64.0.1/hook", // CGNAT
  "https://localhost/hook",
  "https://api.internal/hook",
  "https://[::1]/hook", // IPv6 loopback
  "https://[fd00::1]/hook", // IPv6 ULA
  "https://user:pass@example.com/hook", // embedded credentials
  "http://example.com/hook", // not HTTPS
  "ftp://example.com/hook", // wrong scheme
  "not-a-url",
];

const allowed = [
  "https://hooks.example.com/scan",
  "https://example.test/hook",
  "https://203.0.113.10/hook", // public IP literal
];

describe("assertSafeRelayUrl", () => {
  it.each(blocked)("rejects %s", (url) => {
    expect(() => assertSafeRelayUrl(url)).toThrow();
  });

  it.each(allowed)("allows %s", (url) => {
    expect(() => assertSafeRelayUrl(url)).not.toThrow();
  });
});
