import { readFileSync } from "node:fs";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { endOperatorView, isOperatorRead, isUnauthorized } from "./operatorSession";
import { DEFAULT_STALE_MS, QUERY_DEFAULTS, shouldRetry } from "./queryDefaults";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const key = (...path: string[]) => [path, { type: "query" }];

describe("the operator's reads", () => {
  it("are the admin reads, the key list, payments, operator claims and the client address, and nothing a visitor reads", () => {
    for (const path of [["liveData", "admin", "sources"], ["liveData", "admin", "verifySourceEvidenceBatch"], ["apiKeys", "list"], ["apiPayments", "status"], ["claim", "operatorClaims"], ["operator", "clientAddress"]]) {
      expect(isOperatorRead(key(...path)), path.join(".")).toBe(true);
    }
    for (const path of [["liveData", "publicRecords"], ["claim", "state"], ["operator", "status"], ["atlas", "evidence"], ["liveData", "adminish"]]) {
      expect(isOperatorRead(key(...path)), path.join(".")).toBe(false);
    }
  });

  it("leave the cache at a sign-out, and the page asks again who is signed in, while a visitor's reads stay", async () => {
    const client = new QueryClient();
    client.setQueryData(key("apiKeys", "list"), ["owner@example.com"]);
    client.setQueryData(key("liveData", "admin", "sources"), [{ id: "s" }]);
    client.setQueryData(key("liveData", "publicRecords"), { records: [] });
    client.setQueryData(key("operator", "status"), { authenticated: true });
    endOperatorView(client);
    expect(client.getQueryData(key("apiKeys", "list"))).toBeUndefined();
    expect(client.getQueryData(key("liveData", "admin", "sources"))).toBeUndefined();
    expect(client.getQueryData(key("liveData", "publicRecords"))).toEqual({ records: [] });
    expect(client.getQueryState(key("operator", "status"))?.isInvalidated).toBe(true);
  });

  it("are dropped when the server refuses one as unauthorized, and only then", () => {
    expect(isUnauthorized({ data: { code: "UNAUTHORIZED", httpStatus: 401 } })).toBe(true);
    for (const other of [{ data: { code: "FORBIDDEN" } }, { data: { code: "BAD_REQUEST" } }, new Error("x"), null, undefined, "UNAUTHORIZED"]) expect(isUnauthorized(other)).toBe(false);
    const main = read("../main.tsx");
    expect(main).toContain("if (isUnauthorized(event.query.state.error) && isOperatorRead(event.query.queryKey)) endOperatorView(queryClient);");
    expect(main).toContain("if (isUnauthorized(event.mutation.state.error)) endOperatorView(queryClient);");
  });
});

describe("the operator page", () => {
  const page = read("../pages/SourceOperations.tsx");

  it("says it could not reach the server, with a retry, when its first sign-in check fails, before it would say 'not configured'", () => {
    const error = page.indexOf("if (operatorQuery.isError && !operatorQuery.data) {");
    expect(error).toBeGreaterThan(0);
    expect(error).toBeLessThan(page.indexOf("if (!operatorQuery.data?.configured) {"));
    expect(page).toContain("onClick={() => void operatorQuery.refetch()}");
  });

  it("drops the session's reads at a sign-out, and says when the sign-out failed", () => {
    const logout = page.slice(page.indexOf("const logoutMutation"), page.indexOf("const registerMutation"));
    expect(logout).toContain("endOperatorView(queryClient);");
    expect(logout).toContain("onError: error => setNotice(error.message),");
  });
});

describe("the query defaults", () => {
  it("keep a read fresh for 30 seconds, and give the cache to every page", () => {
    expect(DEFAULT_STALE_MS).toBe(30_000);
    expect(QUERY_DEFAULTS.queries.staleTime).toBe(30_000);
    expect(read("../main.tsx")).toContain("new QueryClient({ defaultOptions: QUERY_DEFAULTS })");
  });

  it("try a failed read once more, and never one the server refused", () => {
    const serverError = { data: { httpStatus: 500 } };
    expect(shouldRetry(0, serverError)).toBe(true);
    expect(shouldRetry(1, serverError)).toBe(false);
    expect(shouldRetry(0, new TypeError("Failed to fetch"))).toBe(true);
    for (const status of [400, 401, 403, 404, 429]) expect(shouldRetry(0, { data: { httpStatus: status } }), String(status)).toBe(false);
  });
});

describe("the claim panel", () => {
  const panel = read("../components/claim/ClaimPanel.tsx");

  it("lets the visitor stop waiting for a wallet, with the button enabled while it waits", () => {
    expect(panel).toContain('{(step === "connecting" || step === "signing") && (');
    const button = panel.slice(panel.indexOf("onClick={stopWaiting}") - 120, panel.indexOf("onClick={stopWaiting}"));
    expect(button).not.toContain("disabled");
  });

  it("ignores a wallet's answer that comes after the visitor stopped waiting, and sends no late signature", () => {
    expect(panel).toContain("if (attempt.current === mine) setConnected({ address, wallet });");
    const sign = panel.slice(panel.indexOf("async function sign()"), panel.indexOf('setStep("checking");'));
    expect(sign).toContain("if (attempt.current !== mine) return;");
  });
});
