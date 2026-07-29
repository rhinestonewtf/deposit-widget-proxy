import { describe, expect, test } from "bun:test";
import {
  createTrustedProxyCheck,
  isPrivateIp,
  normalizeCountry,
  normalizeTrustedCountryHeader,
  resolveClientIp,
  resolveEdgeSignals,
} from "./geoip";

const TRUSTED = createTrustedProxyCheck("10.0.0.0/8");
const CLIENT = "203.0.113.7";

/** A request whose only headers are the ones given. */
function req(headers: Record<string, string>, directIp?: string) {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    directIp,
  };
}

describe("normalizeCountry", () => {
  test("normalizes case and whitespace", () => {
    expect(normalizeCountry(" ph ")).toBe("PH");
  });

  test("rejects non-ISO-2 and MaxMind non-countries", () => {
    for (const raw of ["PHL", "", "1A", "XX", "ZZ", "T1", "AP", "EU", null]) {
      expect(normalizeCountry(raw)).toBeNull();
    }
  });
});

describe("normalizeTrustedCountryHeader", () => {
  test("lower-cases a CDN header name", () => {
    expect(normalizeTrustedCountryHeader("CF-IPCountry")).toBe("cf-ipcountry");
  });

  test("refuses the headers this proxy itself sets upstream", () => {
    // Reading country from the same header we write would let a browser pick its
    // own region, which is the entire threat this guards.
    for (const name of ["x-user-country", "X-Client-IP"]) {
      expect(() => normalizeTrustedCountryHeader(name)).toThrow();
    }
  });
});

describe("createTrustedProxyCheck", () => {
  test("matches inside the subnet and not outside", () => {
    expect(TRUSTED?.("10.1.2.3")).toBe(true);
    expect(TRUSTED?.(CLIENT)).toBe(false);
  });

  test("is undefined when unconfigured", () => {
    expect(createTrustedProxyCheck(undefined)).toBeUndefined();
    expect(createTrustedProxyCheck("  ")).toBeUndefined();
  });

  test("fails startup on a malformed entry rather than silently widening", () => {
    expect(() => createTrustedProxyCheck("not-an-ip")).toThrow();
    expect(() => createTrustedProxyCheck("10.0.0.0/99")).toThrow();
  });
});

describe("resolveClientIp", () => {
  test("hops 0 uses the socket peer", () => {
    expect(
      resolveClientIp({ forwardedFor: undefined, directIp: CLIENT, trustedHops: 0 }),
    ).toBe(CLIENT);
  });

  test("hops 1 takes the entry before the trusted peer", () => {
    expect(
      resolveClientIp({
        forwardedFor: CLIENT,
        directIp: "10.0.0.1",
        trustedHops: 1,
        isTrustedProxy: TRUSTED,
      }),
    ).toBe(CLIENT);
  });

  test("ignores extra forged entries the browser prepended", () => {
    // The browser sends `x-forwarded-for: 1.2.3.4`; the ingress appends the real
    // client. Counting hops from the RIGHT is what makes the forgery inert.
    expect(
      resolveClientIp({
        forwardedFor: `1.2.3.4, ${CLIENT}`,
        directIp: "10.0.0.1",
        trustedHops: 1,
        isTrustedProxy: TRUSTED,
      }),
    ).toBe(CLIENT);
  });

  test("fails closed when a hop is not in the allowlist", () => {
    expect(
      resolveClientIp({
        forwardedFor: CLIENT,
        directIp: "198.51.100.9",
        trustedHops: 1,
        isTrustedProxy: TRUSTED,
      }),
    ).toBeNull();
  });

  test("fails closed on a malformed chain instead of repairing it", () => {
    // Dropping the junk entry would shift hop positions and could promote an
    // attacker-controlled address into the client slot.
    expect(
      resolveClientIp({
        forwardedFor: `garbage, ${CLIENT}`,
        directIp: "10.0.0.1",
        trustedHops: 1,
        isTrustedProxy: TRUSTED,
      }),
    ).toBeNull();
  });

  test("fails closed when the chain is shorter than the trusted hop count", () => {
    expect(
      resolveClientIp({
        forwardedFor: undefined,
        directIp: "10.0.0.1",
        trustedHops: 2,
        isTrustedProxy: TRUSTED,
      }),
    ).toBeNull();
  });

  test("fails closed when hops > 0 but no allowlist is configured", () => {
    expect(
      resolveClientIp({
        forwardedFor: CLIENT,
        directIp: "10.0.0.1",
        trustedHops: 1,
      }),
    ).toBeNull();
  });
});

describe("isPrivateIp", () => {
  test("covers private, loopback, CGNAT and link-local", () => {
    for (const ip of ["10.0.0.1", "192.168.1.1", "127.0.0.1", "100.64.0.1", "::1", "fd00::1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    expect(isPrivateIp(CLIENT)).toBe(false);
  });
});

describe("resolveEdgeSignals", () => {
  test("prefers a trusted CDN country header over an IP", () => {
    const signals = resolveEdgeSignals(
      req({ "cf-ipcountry": "PH", "x-forwarded-for": CLIENT }, "10.0.0.1"),
      { countryHeader: "cf-ipcountry", trustedHops: 1, isTrustedProxy: TRUSTED },
    );

    expect(signals).toEqual({ country: "PH" });
  });

  test("ignores a country header from an untrusted peer", () => {
    // Straight from a browser, i.e. the peer is not our ingress. It must fall
    // through to IP resolution rather than be believed.
    const signals = resolveEdgeSignals(
      req({ "cf-ipcountry": "PH" }, CLIENT),
      { countryHeader: "cf-ipcountry", trustedHops: 0, isTrustedProxy: TRUSTED },
    );

    expect(signals).toEqual({ clientIp: CLIENT });
  });

  test("relays the client IP when no country header is configured", () => {
    const signals = resolveEdgeSignals(
      req({ "x-forwarded-for": CLIENT }, "10.0.0.1"),
      { trustedHops: 1, isTrustedProxy: TRUSTED },
    );

    expect(signals).toEqual({ clientIp: CLIENT });
  });

  test("relays nothing when hops are unconfigured", () => {
    // The default posture: no localization, no relayed signal.
    expect(
      resolveEdgeSignals(req({ "x-forwarded-for": CLIENT }, "10.0.0.1"), {}),
    ).toEqual({});
  });

  test("never relays a private address", () => {
    // Would have the processor geolocate our own datacentre.
    expect(
      resolveEdgeSignals(req({}, "10.0.0.1"), { trustedHops: 0 }),
    ).toEqual({});
  });

  test("relays nothing when the forwarding chain fails validation", () => {
    expect(
      resolveEdgeSignals(req({ "x-forwarded-for": "garbage" }, "10.0.0.1"), {
        trustedHops: 1,
        isTrustedProxy: TRUSTED,
      }),
    ).toEqual({});
  });
});
