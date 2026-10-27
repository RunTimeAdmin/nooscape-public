import dns from "node:dns";

/**
 * Where DATABASE_URL points, without its password. The boot-time migration runner
 * exits when the database refuses it, and MySQL's "Access denied for user ...@'<address>'"
 * says nothing about which server the app tried, which database, or whether a password
 * was sent at all. A login that fails because the host belongs to another server, the
 * database name is wrong, or the account is not allowed from the app's address looks the
 * same as a wrong password; this puts the rest of the connection in the log so those can
 * be told apart without opening the host's environment. The password, the query string
 * (which can carry TLS material), and the text of a URL that does not parse are never
 * written.
 */
type DatabaseTarget = { host: string; port: number; database: string; user: string; hasPassword: boolean };

function decoded(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseDatabaseTarget(databaseUrl: string): DatabaseTarget | null {
  try {
    const url = new URL(databaseUrl);
    return {
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port ? Number(url.port) : 3306,
      database: decoded(url.pathname.replace(/^\//, "")),
      user: decoded(url.username),
      hasPassword: url.password !== "",
    };
  } catch {
    return null;
  }
}

/** The address a name resolves to (the first the app would try), or why it did not. */
async function resolvedAddress(host: string, lookup: typeof dns.promises.lookup, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { code: "TIMEOUT" })), timeoutMs);
    });
    return (await Promise.race([lookup(host), timeout])).address;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return `lookup failed${typeof code === "string" ? ` (${code})` : ""}`;
  } finally {
    clearTimeout(timer);
  }
}

export async function describeDatabaseTarget(
  databaseUrl: string | undefined,
  options: { lookup?: typeof dns.promises.lookup; timeoutMs?: number } = {}
): Promise<string> {
  if (!databaseUrl) return "DATABASE_URL is not set";
  const target = parseDatabaseTarget(databaseUrl);
  if (!target) return "DATABASE_URL does not parse as a URL (its text is not echoed here)";
  const address = await resolvedAddress(target.host, options.lookup ?? dns.promises.lookup, options.timeoutMs ?? 2_000);
  return `connecting to host=${target.host} (${address}) port=${target.port} database=${target.database || "(none)"} user=${target.user || "(none)"} password=${target.hasPassword ? "set" : "empty"}`;
}
