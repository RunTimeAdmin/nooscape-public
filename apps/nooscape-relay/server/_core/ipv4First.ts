import dns from "node:dns";

/**
 * Looks hostnames up IPv4 first. Hostinger's database host (a srvNNNN.hstgr.io name) has
 * both an A and an AAAA record, and the app's container has an IPv6 address of
 * its own. Node connects to the first address a lookup returns, so a hostname in
 * DATABASE_URL made the app connect over IPv6, where MySQL saw a client address its
 * allowed-host list for the account did not match ("Access denied for user ...@
 * '2a02:4780:...'"), and every boot of the app died at the migration step. An
 * address that fails is still tried after the IPv4 ones, so this costs nothing
 * where IPv6 is the only way through.
 */
export function preferIPv4() {
  dns.setDefaultResultOrder("ipv4first");
}
