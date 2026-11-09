import { publicTlsTarget } from "./public-address";

import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import tls from "node:tls";
import { domainToASCII } from "node:url";

export type DomainTargets = {
  cname: string | null;
  ipv4: Set<string>;
  ipv6: Set<string>;
};

export type DomainDnsSnapshot = {
  txt: string[];
  cname: string[];
  ipv4: string[];
  ipv6: string[];
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function splitCsv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
}

export function domainTargetsFromEnv(): DomainTargets {
  const cnameRaw = process.env.CUSTOM_DOMAIN_CNAME_TARGET?.trim().toLowerCase();
  const cname = cnameRaw ? normalizeDnsName(cnameRaw) : null;

  return {
    cname,
    ipv4: new Set(splitCsv(process.env.CUSTOM_DOMAIN_IPV4_TARGETS)),
    ipv6: new Set(splitCsv(process.env.CUSTOM_DOMAIN_IPV6_TARGETS)),
  };
}

export function verificationRecordHost(hostname: string) {
  const prefix=(process.env.CUSTOM_DOMAIN_VERIFY_PREFIX ?? "_stems-verify").trim();
  return prefix + "." + hostname;
}

export function verificationRecordValue(token: string) {
  return "stems-verification=" + token;
}

export function generateDomainVerificationToken() {
  return randomBytes(24).toString("hex");
}

export function domainClaimExpiry(now = new Date()) {
  const configured = Number(process.env.DOMAIN_CLAIM_TTL_HOURS ?? 24);
  const hours = Number.isFinite(configured) && configured > 0
    ? Math.min(configured, 168)
    : 24;
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

export function normalizeDnsName(value: string) {
  const ascii = domainToASCII(value.trim().toLowerCase().replace(/\.$/, ""));
  if (!ascii) throw new Error("Invalid hostname.");
  return ascii;
}

export function normalizeCustomHostname(value: string) {
  const raw = value.trim().toLowerCase();

  if (!raw) throw new Error("Domain name is required.");
  if (
    raw.includes("://") ||
    raw.includes("/") ||
    raw.includes("?") ||
    raw.includes("#") ||
    raw.includes("@") ||
    raw.includes("*") ||
    raw.includes(":")
  ) {
    throw new Error("Enter a hostname only, without scheme, path, port, or wildcard.");
  }

  const hostname = normalizeDnsName(raw);
  if (hostname.length > 253) throw new Error("Domain name is too long.");
  if (LOCAL_HOSTS.has(hostname) || hostname.endsWith(".localhost")) {
    throw new Error("Local hostnames cannot be registered as custom domains.");
  }
  if (isIP(hostname)) throw new Error("IP addresses cannot be registered as custom domains.");

  const labels = hostname.split(".");
  if (labels.length < 2) throw new Error("Custom domains must contain a public suffix.");
  for (const label of labels) {
    if (
      label.length < 1 ||
      label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ) {
      throw new Error("Domain contains an invalid DNS label.");
    }
  }

  const reserved = new Set(splitCsv(process.env.CUSTOM_DOMAIN_RESERVED_SUFFIXES));
  const nextAuthHost = (() => {
    try {
      return process.env.NEXTAUTH_URL
        ? new URL(process.env.NEXTAUTH_URL).hostname.toLowerCase()
        : null;
    } catch {
      return null;
    }
  })();
  if (nextAuthHost) reserved.add(nextAuthHost);

  for (const suffix of reserved) {
    if (hostname === suffix || hostname.endsWith("." + suffix)) {
      throw new Error("That hostname belongs to a reserved platform namespace.");
    }
  }

  return hostname;
}

export function domainRoutingMatches(
  snapshot: Pick<DomainDnsSnapshot, "cname" | "ipv4" | "ipv6">,
  targets: DomainTargets,
) {
  if (
    targets.cname &&
    snapshot.cname.some((entry) => normalizeDnsName(entry) === targets.cname)
  ) {
    return true;
  }

  const addresses = [...snapshot.ipv4, ...snapshot.ipv6].map((entry) =>
    entry.toLowerCase(),
  );
  if (addresses.length === 0) return false;

  const allowed = new Set([...targets.ipv4, ...targets.ipv6]);
  if (allowed.size === 0) return false;

  return addresses.every((address) => allowed.has(address));
}

export function domainRoutingConfigured(targets = domainTargetsFromEnv()) {
  return Boolean(targets.cname || targets.ipv4.size || targets.ipv6.size);
}

async function safeResolve<T>(resolver: () => Promise<T>, fallback: T) {
  try {
    return await resolver();
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (["ENODATA","ENOTFOUND","ESERVFAIL","ETIMEOUT","EREFUSED"].includes(code)) {
      return fallback;
    }
    throw error;
  }
}

export async function readDomainDns(hostname: string): Promise<DomainDnsSnapshot> {
  const txtRows = await safeResolve(
    () => dns.resolveTxt(verificationRecordHost(hostname)),
    [] as string[][],
  );

  const [cname, ipv4, ipv6] = await Promise.all([
    safeResolve(() => dns.resolveCname(hostname), [] as string[]),
    safeResolve(() => dns.resolve4(hostname), [] as string[]),
    safeResolve(() => dns.resolve6(hostname), [] as string[]),
  ]);

  return {
    txt: txtRows.map((row) => row.join("")),
    cname,
    ipv4,
    ipv6,
  };
}

export function ownershipVerified(snapshot: DomainDnsSnapshot, token: string) {
  return snapshot.txt.includes(verificationRecordValue(token));
}

export async function verifyDomainTls(
  hostname: string,
  timeoutMs = Number(process.env.CUSTOM_DOMAIN_TLS_TIMEOUT_MS ?? 5000),
) {
  const timeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, 15000)
      : 5000;

  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  const target = await Promise.race([
    publicTlsTarget(hostname),
    new Promise<never>((_, reject) => {
      dnsTimer = setTimeout(() => reject(new Error("TLS DNS lookup timed out.")), timeout);
    }),
  ]).finally(() => clearTimeout(dnsTimer));
  const remaining = Math.max(1, timeout - (Date.now() - startedAt));

  return new Promise<void>((resolve, reject) => {
    const socket = tls.connect({
      host: target.address,
      port: 443,
      servername: hostname,
      rejectUnauthorized: true,
    });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("TLS handshake timed out."));
    }, remaining);

    socket.once("secureConnect", () => {
      clearTimeout(timer);
      if (!socket.authorized) {
        const reason = socket.authorizationError
          ? String(socket.authorizationError)
          : "certificate authorization failed";
        socket.destroy();
        reject(new Error("TLS certificate is not ready: " + reason));
        return;
      }
      socket.end();
      resolve();
    });

    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
