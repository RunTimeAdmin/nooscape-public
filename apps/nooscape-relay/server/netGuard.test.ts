import { describe, expect, it } from "vitest";
import { isClearlyUnsafeHostname, isForbiddenIp, isForbiddenIpv4 } from "./netGuard";

describe("fetch-boundary address guard", () => {
  it("blocks private, loopback, link-local, CGNAT, and reserved IPv4 space", () => {
    for (const address of [
      "0.1.2.3",
      "10.0.0.1",
      "100.64.0.1",
      "100.127.255.255",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "192.0.0.10",
      "192.0.2.1",
      "192.0.2.255",
      "192.88.99.2",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.1",
      "198.51.100.255",
      "203.0.113.1",
      "203.0.113.255",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isForbiddenIpv4(address), address).toBe(true);
      expect(isForbiddenIp(address), address).toBe(true);
    }
  });

  it("allows globally routable IPv4 addresses", () => {
    for (const address of [
      "1.1.1.1",
      "8.8.8.8",
      "100.63.255.255",
      "100.128.0.1",
      "172.15.255.255",
      "172.32.0.1",
      "192.0.1.1",
      "192.0.3.1",
      "192.88.98.255",
      "192.88.100.1",
      "192.167.255.255",
      "198.17.255.255",
      "198.20.0.1",
      "198.51.99.255",
      "198.51.101.1",
      "203.0.112.255",
      "203.0.114.1",
      "223.255.255.255",
    ]) {
      expect(isForbiddenIpv4(address), address).toBe(false);
      expect(isForbiddenIp(address), address).toBe(false);
    }
  });

  it("blocks every IPv4-mapped, loopback, ULA, link-local, multicast, NAT64, 6to4, Teredo, documentation, discard, and segment-routing IPv6 form", () => {
    for (const address of [
      "::",
      "::1",
      "fc00::1",
      "fdff:ffff::1",
      "fe80::1",
      "fe90::1",
      "fea0::1",
      "febf:ffff::1",
      "fec0::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:a9fe:a9fe",
      "::ffff:ac10:1",
      "::ffff:7f00:1",
      "::ffff:8.8.8.8",
      "::a00:1",
      "64:ff9b::a00:1",
      "64:ff9b:1::1",
      "2002:0a00::1",
      "2001::1",
      "2001:2::1",
      "2001:10::1",
      "2001:1ff:ffff::1",
      "2001:db8::1",
      "3fff::1",
      "3fff:fff:ffff::1",
      "100::1",
      "100:0:0:1::1",
      "5f00::1",
    ]) {
      expect(isForbiddenIp(address), address).toBe(true);
    }
  });

  it("allows IPv6 addresses outside the forbidden special-purpose ranges", () => {
    for (const address of ["2606:4700::1111", "2001:4860:4860::8888", "2001:200::1", "2a00:1450:4001:81b::200e", "fe7f::1"]) {
      expect(isForbiddenIp(address), address).toBe(false);
    }
  });

  it("fails closed for non-address input and rejects unsafe hostnames", () => {
    expect(isForbiddenIp("not-an-ip")).toBe(true);
    for (const hostname of ["localhost", "api.localhost", "db.local", "svc.internal", "127.0.0.1", "2606:4700::1111", "localhost."]) {
      expect(isClearlyUnsafeHostname(hostname), hostname).toBe(true);
    }
    for (const hostname of ["agents.example.org", "sub.local.agents.example.org", "example.dev"]) {
      expect(isClearlyUnsafeHostname(hostname), hostname).toBe(false);
    }
  });
});
