/**
 * Localizing the deposit modal's fiat on-ramp needs the END USER's country, and
 * this proxy is the only component in the chain that can see them: the processor
 * sits behind it and only ever observes this proxy's own address.
 *
 * Naming the client is irreducibly the edge's job — a header the browser can
 * reach is a header the browser can lie in — so it needs to know your ingress
 * topology. That is the one thing you have to configure. The IP→country lookup
 * is NOT here: the processor owns the GeoIP database, so you don't need a MaxMind
 * licence to get localized payment methods.
 *
 * Everything is opt-in and fails closed. With nothing configured this resolves
 * nothing, the processor sees no country, and the modal shows its generic set of
 * payment methods — exactly today's behaviour.
 */
import { BlockList, isIP } from "node:net";

/**
 * MaxMind's codes for "not a country" (anonymous proxy, satellite, the EU
 * aggregate). They pass an ISO-2 shape check but select no payment-method
 * catalog, so a CDN reporting one is treated as unresolved.
 */
const NON_COUNTRIES = new Set(["XX", "ZZ", "T1", "AP", "EU"]);

export function normalizeCountry(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const country = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return null;
  return NON_COUNTRIES.has(country) ? null : country;
}

/**
 * The upstream header names are ours to set, never to accept. Refusing to read
 * country from the same header we write it to closes the obvious hole: a browser
 * sending `x-user-country` must not be able to pick its own region.
 */
const RESERVED_HEADERS = new Set(["x-user-country", "x-client-ip"]);

export function normalizeTrustedCountryHeader(
  raw: string | undefined,
): string | undefined {
  const header = raw?.trim().toLowerCase();
  if (!header) return undefined;
  if (RESERVED_HEADERS.has(header)) {
    throw new Error(
      `TRUSTED_COUNTRY_HEADER cannot be an upstream header this proxy sets (${header})`,
    );
  }
  return header;
}

function stripPort(value: string): string {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(1, end) : value;
  }
  // One colon is host:port; more than one means a bare IPv6 address.
  if ((value.match(/:/g)?.length ?? 0) === 1) {
    return value.slice(0, value.indexOf(":"));
  }
  return value;
}

function normalizeIp(raw: string | undefined): string | null {
  if (!raw) return null;
  const candidate = stripPort(raw.trim());
  const mapped = candidate.match(
    /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i,
  )?.[1];
  if (mapped && isIP(mapped) === 4) return mapped;
  return isIP(candidate) ? candidate : null;
}

/**
 * Allowlist of peers permitted to supply forwarding or ingress-country headers.
 * An invalid entry fails startup rather than silently widening the boundary — a
 * typo here would otherwise read as "localization just doesn't work".
 */
export function createTrustedProxyCheck(
  rawCidrs: string | undefined,
): ((ip: string) => boolean) | undefined {
  const entries = rawCidrs
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries?.length) return undefined;

  const allowlist = new BlockList();
  for (const entry of entries) {
    const slash = entry.lastIndexOf("/");
    const address = slash >= 0 ? entry.slice(0, slash) : entry;
    const familyNumber = isIP(address);
    if (familyNumber === 0) {
      throw new Error(`TRUSTED_PROXY_CIDRS has an invalid address: ${entry}`);
    }
    const family = familyNumber === 4 ? "ipv4" : "ipv6";

    if (slash < 0) {
      allowlist.addAddress(address, family);
      continue;
    }

    const prefix = Number(entry.slice(slash + 1));
    const maxPrefix = familyNumber === 4 ? 32 : 128;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      throw new Error(`TRUSTED_PROXY_CIDRS has an invalid prefix: ${entry}`);
    }
    allowlist.addSubnet(address, prefix, family);
  }

  return (rawIp: string) => {
    const ip = normalizeIp(rawIp);
    if (!ip) return false;
    return allowlist.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
  };
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  const [a, b] = parts;
  if (a === undefined || b === undefined) return false;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(".") && !ip.includes(":")) return isPrivateIpv4(ip);

  const normalized = ip.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;

  const mapped = normalized.match(
    /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  return /^fe[89ab]/.test(normalized);
}

/**
 * Resolve the client sitting immediately before the configured number of trusted
 * proxies. Every hop from there to us must be in the allowlist.
 */
export function resolveClientIp(args: {
  forwardedFor: string | undefined;
  directIp: string | undefined;
  trustedHops: number;
  isTrustedProxy?: (ip: string) => boolean;
}): string | null {
  const directIp = normalizeIp(args.directIp);
  if (!directIp) return null;
  const trustedHops = Math.max(0, Math.floor(args.trustedHops || 0));
  if (trustedHops === 0) return directIp;
  if (!args.isTrustedProxy) return null;

  // Never repair a malformed forwarding chain by dropping entries: that shifts
  // hop positions and can promote an attacker-controlled address into the
  // apparent client slot. Localization is optional, so failing closed is free.
  const chain: string[] = [];
  for (const rawIp of (args.forwardedFor ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const ip = normalizeIp(rawIp);
    if (!ip) return null;
    chain.push(ip);
  }
  chain.push(directIp);

  const index = chain.length - 1 - trustedHops;
  if (index < 0) return null;
  if (
    !chain
      .slice(index + 1)
      .every((trustedIp) => args.isTrustedProxy?.(trustedIp) === true)
  ) {
    return null;
  }
  return chain[index] ?? null;
}

export interface EdgeConfig {
  /** Header your ingress sets with an already-resolved country, e.g. `cf-ipcountry`. */
  countryHeader?: string;
  /**
   * Number of trusted proxies between the browser and this process, or undefined
   * to resolve no IP at all. 0 means nothing is in front (the socket peer IS the
   * client); N > 0 walks `x-forwarded-for` and requires `isTrustedProxy`.
   */
  trustedHops?: number;
  isTrustedProxy?: (ip: string) => boolean;
}

/**
 * What to relay upstream. At most one of these is set:
 *
 * - `country` — the ingress already knew it; no lookup needed anywhere.
 * - `clientIp` — we can name the user but not their country; the processor
 *   resolves it against its own database.
 */
export interface EdgeSignals {
  country?: string;
  clientIp?: string;
}

export function resolveEdgeSignals(
  request: {
    header: (name: string) => string | undefined;
    directIp: string | undefined;
  },
  config: EdgeConfig,
): EdgeSignals {
  // A CDN country header is only believable if the request actually came from
  // the CDN. Without a trusted-peer allowlist any browser could send it.
  if (
    config.countryHeader &&
    request.directIp &&
    config.isTrustedProxy?.(request.directIp)
  ) {
    const country = normalizeCountry(request.header(config.countryHeader));
    if (country) return { country };
  }

  if (config.trustedHops === undefined) return {};

  const clientIp = resolveClientIp({
    forwardedFor: request.header("x-forwarded-for"),
    directIp: request.directIp,
    trustedHops: config.trustedHops,
    isTrustedProxy: config.isTrustedProxy,
  });
  // A private address means we resolved one of our own hops, not the user —
  // relaying it would have the processor geolocate a datacentre.
  if (!clientIp || isPrivateIp(clientIp)) return {};
  return { clientIp };
}
