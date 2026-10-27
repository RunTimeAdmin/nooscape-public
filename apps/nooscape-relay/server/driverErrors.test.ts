import { afterEach, describe, expect, it, vi } from "vitest";
import { driverErrorHas, isMissingSchema, isMissingTable, noteSectionFailure } from "./driverErrors";

/** A MySQL driver error: an Error that carries the server's code. */
const driverError = (code: string) => Object.assign(new Error("driver message"), { code });

/** What Drizzle does to a failed query: the driver's error becomes the `cause` of its own, and a wrapper can be wrapped again. */
const wrapped = (inner: unknown, depth = 1): Error => {
  let error: unknown = inner;
  for (let level = 0; level < depth; level += 1) error = new Error("Failed query: select 1", { cause: error });
  return error as Error;
};

describe("finding a MySQL driver code in an error", () => {
  it("finds the code on the error itself", () => {
    expect(driverErrorHas(driverError("ER_DUP_ENTRY"), "ER_DUP_ENTRY")).toBe(true);
  });

  it("finds the code on the cause that Drizzle wraps the driver error in, and on a cause of that", () => {
    expect(driverErrorHas(wrapped(driverError("ER_DUP_ENTRY")), "ER_DUP_ENTRY")).toBe(true);
    expect(driverErrorHas(wrapped(driverError("ER_DUP_ENTRY"), 2), "ER_DUP_ENTRY")).toBe(true);
  });

  it("looks at four errors in the chain and no further", () => {
    expect(driverErrorHas(wrapped(driverError("ER_DUP_ENTRY"), 3), "ER_DUP_ENTRY")).toBe(true);
    expect(driverErrorHas(wrapped(driverError("ER_DUP_ENTRY"), 4), "ER_DUP_ENTRY")).toBe(false);
  });

  it("says no for another code, for an error with no code, and for what is not an error at all", () => {
    expect(driverErrorHas(driverError("ER_DUP_ENTRY"), "ER_NO_SUCH_TABLE")).toBe(false);
    expect(driverErrorHas(new Error("no code"), "ER_NO_SUCH_TABLE")).toBe(false);
    for (const value of [undefined, null, "ER_NO_SUCH_TABLE", 1146]) expect(driverErrorHas(value, "ER_NO_SUCH_TABLE")).toBe(false);
  });

  it("accepts a plain object that carries a code, as the key, payment and webhook stores always did", () => {
    expect(driverErrorHas({ code: "ER_NO_SUCH_TABLE" }, "ER_NO_SUCH_TABLE")).toBe(true);
    expect(driverErrorHas({ cause: { code: "ER_NO_SUCH_TABLE" } }, "ER_NO_SUCH_TABLE")).toBe(true);
  });
});

describe("a table that is not there", () => {
  it("is the driver's ER_NO_SUCH_TABLE, found through the wrapping", () => {
    expect(isMissingTable(driverError("ER_NO_SUCH_TABLE"))).toBe(true);
    expect(isMissingTable(wrapped(driverError("ER_NO_SUCH_TABLE")))).toBe(true);
  });

  it("is no other failure: a timeout, a refused connection or a duplicate key is not a missing table", () => {
    for (const code of ["ER_QUERY_TIMEOUT", "ECONNREFUSED", "ER_DUP_ENTRY", "ER_BAD_FIELD_ERROR"]) expect(isMissingTable(wrapped(driverError(code)))).toBe(false);
  });
});

describe("a table or a column that is not there", () => {
  it("is a missing table or a missing column, which is what a migration not run yet looks like", () => {
    expect(isMissingSchema(wrapped(driverError("ER_NO_SUCH_TABLE")))).toBe(true);
    expect(isMissingSchema(wrapped(driverError("ER_BAD_FIELD_ERROR")))).toBe(true);
  });

  it("is no other failure", () => {
    for (const code of ["ER_QUERY_TIMEOUT", "ECONNREFUSED", "ER_LOCK_DEADLOCK", "DB_CIRCUIT_OPEN"]) expect(isMissingSchema(wrapped(driverError(code))), code).toBe(false);
  });
});

describe("a part of a page that is allowed to come back empty", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const said = () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    return () => warn.mock.calls.map(call => call.join(" "));
  };

  it("stays quiet when its table or column is not there yet", () => {
    const lines = said();
    noteSectionFailure("Entry twin", wrapped(driverError("ER_NO_SUCH_TABLE")));
    noteSectionFailure("Entry activity", wrapped(driverError("ER_BAD_FIELD_ERROR")));
    expect(lines()).toEqual([]);
  });

  it("stays quiet while the database circuit is open, which the breaker has said once", () => {
    const lines = said();
    noteSectionFailure("Entry ratings", wrapped(driverError("DB_CIRCUIT_OPEN")));
    expect(lines()).toEqual([]);
  });

  it("logs any other failure, with the part that failed and the driver's code", () => {
    const lines = said();
    noteSectionFailure("Entry twin", wrapped(driverError("ER_QUERY_TIMEOUT")));
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain("[LiveData] Entry twin could not be read:");
    expect(lines()[0]).toContain("ER_QUERY_TIMEOUT");
  });

  it("leaves the query's parameters out of the line, and writes one line however long the message is", () => {
    const lines = said();
    const failed = new Error("Failed query: select name from t where id = ?" + String.fromCharCode(10) + "params: private-id-1234" + "x".repeat(500), { cause: driverError("ER_QUERY_TIMEOUT") });
    noteSectionFailure("Entry twin", failed);
    const line = lines()[0]!;
    expect(line).not.toContain("private-id-1234");
    expect(line).not.toContain(String.fromCharCode(10));
    expect(line.length).toBeLessThan(400);
  });

  it("says something even when what failed is not an error at all", () => {
    const lines = said();
    noteSectionFailure("Entry twin", "a string was thrown");
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain("a string was thrown");
  });
});
