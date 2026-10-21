import { describe, expect, it } from "vitest";
import { A2aValidationError, normalizeA2aAgentCard, validateA2aSourceRoot } from "./a2a";

describe("A2A source registration", () => {
  it("canonicalizes an HTTPS source to one well-known AgentCard URL", () => {
    expect(validateA2aSourceRoot("https://Agents.Example.org/some/path?ignored=true")).toEqual({
      rootUrl: "https://agents.example.org",
      allowedHostname: "agents.example.org",
      cardUrl: "https://agents.example.org/.well-known/agent-card.json",
      sourceKey: "a2a-agents-example-org",
    });
  });

  it.each([
    "http://agent.example.org",
    "https://127.0.0.1",
    "https://localhost",
    "https://service.internal",
    "https://user:secret@agent.example.org",
    "https://agent.example.org:8443",
  ])("rejects an unsafe source root: %s", source => {
    expect(() => validateA2aSourceRoot(source)).toThrow(A2aValidationError);
  });
});

describe("A2A AgentCard normalization", () => {
  it("extracts declared metadata without executing an endpoint", () => {
    const candidate = normalizeA2aAgentCard(
      {
        name: "Research Beacon",
        description: "Public metadata-only research capability.",
        url: "https://agent.example.org/a2a",
        securitySchemes: { oauth2: { type: "oauth2" } },
        skills: [{ name: "Research" }, { name: "Synthesis" }, { ignored: true }],
      },
      "https://agent.example.org/.well-known/agent-card.json"
    );

    expect(candidate).toMatchObject({
      displayName: "Research Beacon",
      handle: "research-beacon",
      primaryCapability: "Research",
      specialties: ["Research", "Synthesis"],
      endpointUrl: "https://agent.example.org/a2a",
      authentication: "oauth2",
    });
  });

  describe("the address a card declares", () => {
    const CARD_URL = "https://agent.example.org/.well-known/agent-card.json";
    const endpointOf = (card: Record<string, unknown>) => normalizeA2aAgentCard({ name: "Interface Agent", ...card }, CARD_URL).endpointUrl;

    it("reads the first interface of an A2A 1.0 card that has no top-level url, as the live AgentCard.net card declares it", () => {
      const interfaces = [{ url: "https://www.agentcard.net/api/agent-card", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }];
      expect(endpointOf({ supportedInterfaces: interfaces })).toBe("https://www.agentcard.net/api/agent-card");
    });

    it("keeps reading the top-level url first, whatever the interfaces say", () => {
      const card = { url: "https://agent.example.org/a2a", supportedInterfaces: [{ url: "https://other.example.org/rpc" }] };
      expect(endpointOf(card)).toBe("https://agent.example.org/a2a");
    });

    it("takes the first interface that is an https address, in the order the card lists them, and passes over the rest", () => {
      const interfaces = [
        { url: "grpc.example.org:50051", protocolBinding: "GRPC" },
        { url: "http://insecure.example.org/rpc" },
        { protocolBinding: "JSONRPC" },
        { url: 42 },
        "not an object",
        null,
        ["https://in-an-array.example.org/"],
        { url: "https://second.example.org/rpc/" },
        { url: "https://third.example.org/rpc" },
      ];
      expect(endpointOf({ supportedInterfaces: interfaces })).toBe("https://second.example.org/rpc/");
    });

    it("declares no address, and does not refuse the card, when no interface is an https address", () => {
      expect(endpointOf({ supportedInterfaces: [{ url: "http://insecure.example.org/rpc" }, { url: "localhost:50051" }, { url: "" }] })).toBeNull();
      expect(endpointOf({ supportedInterfaces: [] })).toBeNull();
    });

    it("passes over a supportedInterfaces that is not a list, and a card with neither", () => {
      expect(endpointOf({ supportedInterfaces: { url: "https://object.example.org/" } })).toBeNull();
      expect(endpointOf({ supportedInterfaces: "https://string.example.org/" })).toBeNull();
      expect(endpointOf({})).toBeNull();
    });

    it("falls through to the interfaces when the top-level url is empty", () => {
      expect(endpointOf({ url: "", supportedInterfaces: [{ url: "https://iface.example.org/a2a" }] })).toBe("https://iface.example.org/a2a");
    });

    it("still refuses a card whose top-level url is not https, whatever its interfaces say", () => {
      expect(() => endpointOf({ url: "http://agent.example.org/a2a", supportedInterfaces: [{ url: "https://good.example.org/" }] })).toThrow("HTTPS URL");
    });

    it("only reads the address: it never calls it, and the rest of the candidate is as it was", () => {
      const candidate = normalizeA2aAgentCard({ name: "Interface Agent", description: "d", supportedInterfaces: [{ url: "https://iface.example.org/a2a" }] }, CARD_URL);
      expect(candidate).toMatchObject({ displayName: "Interface Agent", summary: "d", agentCardUrl: CARD_URL, authentication: null, endpointUrl: "https://iface.example.org/a2a" });
    });
  });

  it("rejects malformed AgentCards before persistence", () => {
    expect(() => normalizeA2aAgentCard({ description: "No name" }, "https://agent.example.org/.well-known/agent-card.json")).toThrow(
      "requires a name"
    );
    expect(() => normalizeA2aAgentCard({ name: "Unsafe URL", url: "http://agent.example.org" }, "https://agent.example.org/.well-known/agent-card.json")).toThrow(
      "HTTPS URL"
    );
  });
});
