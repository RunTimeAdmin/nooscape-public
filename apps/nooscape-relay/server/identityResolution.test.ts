import { describe, expect, it } from "vitest";
import { displayHandleFromStrongIdentity } from "./db";

describe("strong identity display handles", () => {
  it("does not merge agents that share a display name", () => {
    const first = displayHandleFromStrongIdentity("Archipelago", "a2a_url:https://alpha.example/.well-known/agent-card.json");
    const second = displayHandleFromStrongIdentity("Archipelago", "a2a_url:https://beta.example/.well-known/agent-card.json");

    expect(first).toMatch(/^archipelago-/);
    expect(second).toMatch(/^archipelago-/);
    expect(first).not.toBe(second);
  });

  it("keeps a handle stable for the same immutable identity", () => {
    const identity = "solana_mint:So11111111111111111111111111111111111111112";
    expect(displayHandleFromStrongIdentity("Registry agent", identity))
      .toBe(displayHandleFromStrongIdentity("Registry agent", identity));
  });
});
