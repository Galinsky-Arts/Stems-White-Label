import assert from "node:assert/strict";
import test from "node:test";
import { isPublicAddress, publicTlsTarget } from "./public-address";

test("TLS egress rejects local, private, metadata, documentation and transition addresses", () => {
  for (const ip of ["0.0.0.0", "10.1.2.3", "100.100.100.200", "127.0.0.1", "169.254.169.254", "172.31.0.1", "192.168.1.1", "192.0.0.8", "192.0.2.3", "198.19.1.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "2001::1", "2002:7f00:1::", "3fff::1", "not-an-ip"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) assert.equal(isPublicAddress(ip), true, ip);
});

test("TLS resolution rejects mixed DNS answers and pins the accepted address", async () => {
  await assert.rejects(publicTlsTarget("store.example", async () => []));
  await assert.rejects(publicTlsTarget("store.example", async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]));
  let lookups = 0;
  const target = await publicTlsTarget("store.example", async () => {
    lookups++;
    return [{ address: "8.8.8.8", family: 4 }];
  });
  assert.equal(target.address, "8.8.8.8");
  assert.equal(lookups, 1);
});
