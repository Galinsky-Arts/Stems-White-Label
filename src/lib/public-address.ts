import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
// Exclude special-purpose/transition networks rather than forwarding them to
// embedded IPv4 addresses, and documentation-only addresses.
blockedV6.addSubnet("2001::", 23, "ipv6");
blockedV6.addSubnet("2001:db8::", 32, "ipv6");
blockedV6.addSubnet("2002::", 16, "ipv6");
blockedV6.addSubnet("3fff::", 20, "ipv6");

export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  if (family === 6) return globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
  return false;
}

type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;

export async function publicTlsTarget(
  hostname: string,
  resolve: Resolver = (host) => dns.lookup(host, { all: true, verbatim: true }),
) {
  const addresses = await resolve(hostname);
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error("Custom-domain TLS checks require public addresses.");
  }
  // Use the validated IP in the socket. Retain the hostname solely for SNI and
  // certificate verification, preventing a second lookup/DNS rebinding.
  return addresses[0]!;
}
