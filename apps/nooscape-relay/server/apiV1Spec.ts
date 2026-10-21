import { EXTRA_CHAIN_LABEL, extraProtocolOf, type ExtraChainKey } from "@shared/chains";

/**
 * The REST API, version 1, as an OpenAPI 3.1 document (served at /api/v1/openapi.json). It is a plain object so a test can hold it to
 * the real answers: server/apiV1.test.ts checks every answer the API gives against the schemas below, and every path below against
 * the router, so the document cannot say something the API does not do.
 *
 * It uses only the parts of JSON Schema that test understands: type, enum, const, properties, required, additionalProperties, items,
 * format (date-time) and $ref.
 */

const nullable = (type: string, extra: Record<string, unknown> = {}) => ({ type: [type, "null"], ...extra });
const dateTime = { type: "string", format: "date-time" } as const;
const nullableDateTime = { type: ["string", "null"], format: "date-time" } as const;

/**
 * The chains the document names. The lists that are shared by reference with {@link apiV1SpecFor} are the ones it can swap: with
 * Ethereum, Base or Arc switched on they gain that chain, and so do the watchlist's, which cover every chain the API serves.
 */
const CHAINS = ["robinhood", "bnb", "solana"];
const CHAINS_OR_NULL = [...CHAINS, null];
const WATCH_CHAINS = ["robinhood", "bnb", "solana"];
const WATCH_CHAINS_OR_NULL = [...WATCH_CHAINS, null];

const license = {
  type: "object",
  description: "The terms the data is offered under. Provisional until a final data license is published.",
  required: ["name", "url", "attribution", "notes"],
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    url: { type: "string" },
    attribution: { type: "string", description: "The line to show where the data is used." },
    notes: { type: "string" },
  },
};

const agentSource = {
  type: "object",
  description: "Where the record was read from.",
  required: ["kind", "chain", "chain_id", "registry", "registry_address", "key", "first_seen_at", "last_seen_at", "mint_block"],
  additionalProperties: false,
  properties: {
    kind: { const: "registry" },
    chain: { enum: CHAINS },
    chain_id: nullable("integer", { description: "The EVM chain id, or null on Solana." }),
    registry: { type: "string", description: "The registry Nooscape read the agent from, by its name on Nooscape (erc8004, erc8004_bsc, solana_8004, solana_said, solana_registry)." },
    registry_address: nullable("string", { description: "The registry contract, or null on Solana." }),
    key: { type: "string", description: "The registry key Nooscape stores the agent under." },
    first_seen_at: nullableDateTime,
    last_seen_at: dateTime,
    mint_block: nullable("integer", { description: "The block the identity was minted in, where Nooscape has read it." }),
  },
};

const evidence = {
  type: "object",
  description: "What Nooscape has on record about this agent, and what that does not mean. Every agent here is acknowledged, never reviewed, and has no tier.",
  required: ["layer", "level", "label", "read_at", "statement"],
  additionalProperties: false,
  properties: {
    layer: { const: "acknowledged" },
    level: { type: ["string", "null"], enum: ["checked_unproven", "not_checked", null], description: "BNB Smart Chain only: whether Nooscape has read the entry's registration. Null elsewhere." },
    label: { type: ["string", "null"], enum: ["Checked, unproven", "Not checked", null] },
    read_at: nullableDateTime,
    statement: { type: "string" },
  },
};

const claim = {
  type: ["object", "null"],
  description: "The claim in force for this agent, or null. A claim is the owner's own word and changes nothing about how the agent is listed.",
  required: ["status", "wallet", "claimed_at", "last_owner_check_at", "owner_text"],
  additionalProperties: false,
  properties: {
    status: { enum: ["active", "on_hold"] },
    wallet: { type: "string", description: "The wallet that holds the claim. The registry recorded it as the owner when the claim was made." },
    claimed_at: nullableDateTime,
    last_owner_check_at: nullableDateTime,
    owner_text: {
      type: ["object", "null"],
      description: "What the owner wrote. Null while the claim is on hold, or when nothing is written. Always the owner's word, never Nooscape's.",
      required: ["statement", "name", "website", "description", "links"],
      additionalProperties: false,
      properties: {
        statement: { type: "string" },
        name: { type: ["string", "null"] },
        website: { type: ["string", "null"] },
        description: { type: ["string", "null"] },
        links: { type: "array", items: { type: "string" } },
      },
    },
  },
};

const agent = {
  type: "object",
  required: ["chain", "agent_id", "registry", "nooscape_id", "page_url", "name", "registrant", "locator_host", "first_seen_at", "last_seen_at", "evidence", "source_note", "feedback_count", "related", "activity", "ratings", "twin", "claim"],
  additionalProperties: false,
  properties: {
    chain: { enum: CHAINS },
    agent_id: { type: "string", description: "The token id on an EVM registry, the address on Solana." },
    registry: { type: "string" },
    nooscape_id: { type: "string", description: "The id of the agent's page on nooscape.si." },
    page_url: { type: "string" },
    name: { type: "string", description: "The name the registrant published. It is theirs, not Nooscape's, and has been cleaned of control and invisible characters." },
    registrant: nullable("string", { description: "The wallet that registered the agent, as the registry shows it." }),
    locator_host: nullable("string", { description: "The host of the link the registration carries." }),
    first_seen_at: nullableDateTime,
    last_seen_at: dateTime,
    evidence,
    source_note: nullable("string", { description: "Where this entry came from, in words." }),
    feedback_count: nullable("integer", { description: "The registry's own count of feedback, where Nooscape reads it." }),
    related: {
      type: ["object", "null"],
      description: "How many other listed agents share this one's wallet, name or host. A fact about the listing, not about anyone's intent.",
      required: ["same_wallet", "same_name", "same_host"],
      additionalProperties: false,
      properties: { same_wallet: { type: "integer" }, same_name: { type: "integer" }, same_host: { type: "integer" } },
    },
    activity: {
      type: ["object", "null"],
      description: "Chain activity on the identity, on EVM registries. A count is null where Nooscape has not measured it, never zero.",
      required: ["mint_block", "secondary_transfers", "handouts", "uri_updates"],
      additionalProperties: false,
      properties: {
        mint_block: nullable("integer"),
        secondary_transfers: nullable("integer"),
        handouts: nullable("integer"),
        uri_updates: nullable("integer"),
      },
    },
    ratings: {
      type: ["object", "null"],
      description: "A summary of the ratings recorded against the agent on Robinhood Chain, where they are read.",
      required: ["measured_through_block", "rating_count", "active_rating_count", "revoked_count", "response_count"],
      additionalProperties: false,
      properties: {
        measured_through_block: nullable("integer"),
        rating_count: { type: "integer" },
        active_rating_count: { type: "integer" },
        revoked_count: { type: "integer" },
        response_count: { type: "integer" },
      },
    },
    twin: {
      type: ["object", "null"],
      description: "The same identity registered on another chain, when the registry metadata says so and the key matches exactly one other listed agent.",
      required: ["nooscape_id", "name", "registry", "linked_registry", "metadata_key", "linked_key"],
      additionalProperties: false,
      properties: {
        nooscape_id: { type: "string" },
        name: { type: "string" },
        registry: { type: "string" },
        linked_registry: { type: "string" },
        metadata_key: { type: "string" },
        linked_key: { type: "string" },
      },
    },
    claim,
  },
};

const searchResult = {
  type: "object",
  required: ["chain", "agent_id", "registry", "nooscape_id", "name", "registrant", "locator_host", "first_seen_at", "last_seen_at", "evidence_layer", "links"],
  additionalProperties: false,
  properties: {
    chain: { enum: CHAINS },
    agent_id: { type: "string" },
    registry: { type: "string" },
    nooscape_id: { type: "string" },
    name: { type: "string" },
    registrant: nullable("string"),
    locator_host: nullable("string"),
    first_seen_at: nullableDateTime,
    last_seen_at: nullableDateTime,
    evidence_layer: { const: "acknowledged" },
    links: {
      type: "object",
      required: ["agent", "page"],
      additionalProperties: false,
      properties: { agent: { type: "string", description: "The path of this agent's own answer." }, page: { type: "string" } },
    },
  },
};

const agentResponse = {
  type: "object",
  required: ["api_version", "as_of", "source", "license", "data"],
  additionalProperties: false,
  properties: {
    api_version: { const: "v1" },
    as_of: { ...dateTime, description: "When Nooscape last saw this record at its source." },
    source: { $ref: "#/components/schemas/AgentSource" },
    license: { $ref: "#/components/schemas/License" },
    data: { $ref: "#/components/schemas/Agent" },
  },
};

const searchResponse = {
  type: "object",
  required: ["api_version", "as_of", "source", "license", "data"],
  additionalProperties: false,
  properties: {
    api_version: { const: "v1" },
    as_of: { ...dateTime, description: "When the search ran." },
    source: {
      type: "object",
      required: ["kind", "chains", "registries"],
      additionalProperties: false,
      properties: { kind: { const: "directory_search" }, chains: { type: "array", items: { enum: CHAINS } }, registries: { type: "array", items: { type: "string" } } },
    },
    license: { $ref: "#/components/schemas/License" },
    data: {
      type: "object",
      required: ["query", "matched_total", "matched_total_capped", "results"],
      additionalProperties: false,
      properties: {
        query: {
          type: "object",
          required: ["q", "owner", "host", "chain", "limit"],
          additionalProperties: false,
          properties: { q: nullable("string"), owner: nullable("string"), host: nullable("string"), chain: { type: ["string", "null"], enum: CHAINS_OR_NULL }, limit: { type: "integer" } },
        },
        matched_total: { type: "integer", description: "How many agents matched. With owner or host it counts the exact matches in the page returned." },
        matched_total_capped: { type: "boolean", description: "True when there may be more than matched_total." },
        results: { type: "array", items: { $ref: "#/components/schemas/SearchResult" } },
      },
    },
  },
};

const indexResponse = {
  type: "object",
  required: ["api_version", "as_of", "license", "documentation", "openapi", "rate_limit", "keys", "chains", "endpoints", "statement"],
  additionalProperties: false,
  properties: {
    api_version: { const: "v1" },
    as_of: dateTime,
    license: { $ref: "#/components/schemas/License" },
    documentation: { type: "string" },
    openapi: { type: "string" },
    rate_limit: {
      type: "object",
      required: ["requests", "per", "scope"],
      additionalProperties: false,
      properties: { requests: { type: "integer" }, per: { const: "minute" }, scope: { const: "ip_address" } },
    },
    payments_unresolved_over_hour: { type: ["integer", "null"], description: "Present while pay per call is on or paused: how many payments have not settled for over an hour and are waiting for the operator, or null when that cannot be read." },
    pay_per_call: {
      type: "object",
      description: "Present only while pay per call is on: what a caller with no key may pay for, in USDC on Arc (x402, version 2), and to whom.",
      required: ["protocol", "version", "network", "asset", "pay_to", "prices", "applies_to", "wallets"],
      additionalProperties: false,
      properties: {
        protocol: { const: "x402" },
        version: { const: 2 },
        network: { type: "string" },
        asset: { type: "string" },
        pay_to: { type: "string" },
        prices: {
          type: "object",
          required: ["lookup", "check"],
          additionalProperties: false,
          properties: {
            lookup: { type: "object", required: ["amount", "usd"], additionalProperties: false, properties: { amount: { type: "string", description: "USDC base units (six decimals)." }, usd: { type: "string" } } },
            check: { type: "object", required: ["amount", "usd"], additionalProperties: false, properties: { amount: { type: "string", description: "USDC base units (six decimals)." }, usd: { type: "string" } } },
          },
        },
        applies_to: { type: "array", items: { type: "string" } },
        wallets: { type: "array", items: { enum: ["regular", "smart_contract"] }, description: "The kinds of wallet a payment may come from: regular (an ordinary key's signature), and smart_contract (a deployed wallet whose own code accepts the signature, ERC-1271) when the chain check is on." },
      },
    },
    keys: {
      type: "object",
      description: "How to get a key and what each tier allows.",
      required: ["get_a_key", "header", "tiers"],
      additionalProperties: false,
      properties: {
        get_a_key: { type: "string" },
        header: { type: "string" },
        tiers: {
          type: "array",
          items: {
            type: "object",
            required: ["tier", "per_minute", "per_day"],
            additionalProperties: false,
            properties: { tier: { enum: ["free", "builder", "pro"] }, per_minute: { type: "integer" }, per_day: { type: "integer" } },
          },
        },
      },
    },
    chains: {
      type: "array",
      items: {
        type: "object",
        required: ["chain", "label", "registries"],
        additionalProperties: false,
        properties: { chain: { enum: CHAINS }, label: { type: "string" }, registries: { type: "array", items: { type: "string" } } },
      },
    },
    endpoints: {
      type: "array",
      items: {
        type: "object",
        required: ["method", "path", "summary"],
        additionalProperties: false,
        properties: { method: { enum: ["GET", "POST", "PUT", "DELETE"] }, path: { type: "string" }, summary: { type: "string" } },
      },
    },
    statement: { type: "string" },
  },
};

const historyResponse = {
  type: "object",
  required: ["api_version", "as_of", "source", "license", "data"],
  additionalProperties: false,
  properties: {
    api_version: { const: "v1" },
    as_of: { ...dateTime, description: "When Nooscape last saw this record at its source." },
    source: { $ref: "#/components/schemas/AgentSource" },
    license: { $ref: "#/components/schemas/License" },
    data: {
      type: "object",
      required: ["chain", "agent_id", "registry", "nooscape_id", "registry_events", "registry_events_truncated", "claim_history"],
      additionalProperties: false,
      properties: {
        chain: { enum: CHAINS },
        agent_id: { type: "string" },
        registry: { type: "string" },
        nooscape_id: { type: "string" },
        registry_events: {
          type: "array",
          description: "The identity's own chain events that Nooscape has read, oldest first, up to 24. Empty on Solana, where Nooscape does not read these.",
          items: {
            type: "object",
            required: ["kind", "block_number", "transaction_hash", "log_index", "from", "to", "is_handout"],
            additionalProperties: false,
            properties: {
              kind: { enum: ["mint", "secondary", "uri_update"] },
              block_number: { type: "integer" },
              transaction_hash: { type: "string" },
              log_index: { type: "integer" },
              from: nullable("string"),
              to: nullable("string"),
              is_handout: { type: "boolean", description: "A transfer from the minting wallet inside the first hour of the mint: a platform hand-out, not a sale." },
            },
          },
        },
        registry_events_truncated: { type: "boolean", description: "True when there may be more events than the 24 returned." },
        claim_history: {
          type: "object",
          description: "The public history of claims on this agent: who claimed it and every edit, in order. Text the owner removed, or that belongs to a claim on hold, is left out and shows as withheld.",
          required: ["available", "truncated", "items"],
          additionalProperties: false,
          properties: {
            available: { type: "boolean" },
            truncated: { type: "boolean" },
            items: {
              type: "array",
              items: {
                type: "object",
                required: ["seq", "kind", "field", "old_value", "new_value", "withheld", "wallet", "signature_digest", "reason", "occurred_at"],
                additionalProperties: false,
                properties: {
                  seq: { type: "integer" },
                  kind: { type: "string" },
                  field: nullable("string"),
                  old_value: nullable("string", { description: "The owner's earlier text, as the owner's word." }),
                  new_value: nullable("string", { description: "The owner's text, as the owner's word." }),
                  withheld: { type: "boolean", description: "True when text exists but is not shown." },
                  wallet: nullable("string"),
                  signature_digest: nullable("string"),
                  reason: nullable("string"),
                  occurred_at: dateTime,
                },
              },
            },
          },
        },
      },
    },
  },
};

const batchRequest = {
  type: "object",
  required: ["agents"],
  additionalProperties: false,
  properties: {
    agents: {
      type: "array",
      minItems: 1,
      maxItems: 25,
      items: {
        type: "object",
        required: ["chain", "id"],
        additionalProperties: false,
        properties: { chain: { enum: CHAINS }, id: { type: "string" }, registry: { enum: ["solana_8004", "solana_said", "solana_registry"] } },
      },
    },
  },
};

const batchResponse = {
  type: "object",
  required: ["api_version", "as_of", "source", "license", "data"],
  additionalProperties: false,
  properties: {
    api_version: { const: "v1" },
    as_of: { ...dateTime, description: "When the batch was read." },
    source: { type: "object", required: ["kind", "requested"], additionalProperties: false, properties: { kind: { const: "batch" }, requested: { type: "integer" } } },
    license: { $ref: "#/components/schemas/License" },
    data: {
      type: "object",
      required: ["results"],
      additionalProperties: false,
      properties: {
        results: {
          type: "array",
          description: "One result per requested agent, in the order asked. A request counts once against the key's limits however many agents it names.",
          items: {
            type: "object",
            required: ["chain", "id", "status", "as_of", "source", "agent", "error"],
            additionalProperties: false,
            properties: {
              chain: { type: "string" },
              id: { type: "string" },
              status: { type: "integer", description: "The status that agent's own request would have had: 200, 400, 404 or 409." },
              as_of: nullableDateTime,
              source: { oneOf: [{ $ref: "#/components/schemas/AgentSource" }, { type: "null" }] },
              agent: { oneOf: [{ $ref: "#/components/schemas/Agent" }, { type: "null" }] },
              error: {
                type: ["object", "null"],
                required: ["code", "message"],
                properties: { code: { enum: ["bad_request", "not_found", "ambiguous"] }, message: { type: "string" }, registries: { type: "array", items: { type: "string" } } },
              },
            },
          },
        },
      },
    },
  },
};

const usageResponse = {
  type: "object",
  required: ["api_version", "as_of", "license", "data"],
  additionalProperties: false,
  properties: {
    api_version: { const: "v1" },
    as_of: dateTime,
    license: { $ref: "#/components/schemas/License" },
    data: {
      type: "object",
      required: ["key", "limits", "today", "days"],
      additionalProperties: false,
      properties: {
        key: { type: "object", required: ["prefix", "tier"], additionalProperties: false, properties: { prefix: { type: "string", description: "The first characters of the key." }, tier: { enum: ["free", "builder", "pro"] } } },
        limits: { type: "object", required: ["per_minute", "per_day"], additionalProperties: false, properties: { per_minute: { type: "integer" }, per_day: { type: "integer" } } },
        today: {
          type: "object",
          required: ["date", "used", "remaining", "limit", "resets_at"],
          additionalProperties: false,
          properties: { date: { type: "string" }, used: { type: "integer" }, remaining: { type: "integer" }, limit: { type: "integer" }, resets_at: dateTime },
        },
        days: {
          type: "array",
          description: "The last 30 UTC days, newest first, with the requests made on each and by endpoint.",
          items: {
            type: "object",
            required: ["date", "total", "by_endpoint"],
            additionalProperties: false,
            properties: { date: { type: "string" }, total: { type: "integer" }, by_endpoint: { type: "object", additionalProperties: { type: "integer" } } },
          },
        },
      },
    },
  },
};

const flagBase = {
  present: { type: ["boolean", "null"], description: "True when Nooscape has recorded one, false when it has recorded none, null when it is not measured for this agent. It is a fact about Nooscape's records and not a finding." },
  basis: { type: "string", description: "What the flag rests on, and what it does not mean." },
};

const checkFlags = {
  type: "object",
  description: "Four dated facts. None is a verdict and none is weighed into a score.",
  required: ["first_seen", "ownership_changes", "revoked_feedback", "fleet"],
  additionalProperties: false,
  properties: {
    first_seen: {
      type: "object",
      description: "When Nooscape first saw the listing. Not when the agent was registered.",
      required: ["present", "first_seen_at", "days_since_first_seen", "threshold_days", "basis"],
      additionalProperties: false,
      properties: { ...flagBase, first_seen_at: nullableDateTime, days_since_first_seen: nullable("integer"), threshold_days: { type: "integer", description: "present is true when the listing was first seen within this many days." } },
    },
    ownership_changes: {
      type: "object",
      description: "Changes of hands recorded in Nooscape's ledger of the registry's transfers. EVM registries are located by block (the ledger holds blocks, not clocks); Solana by the date Nooscape recorded the transfer.",
      required: ["present", "changes_recorded", "handouts_recorded", "latest_change_block", "ledger_through_block", "blocks_since_latest_change", "block_days_since_latest_change", "latest_change_recorded_at", "basis"],
      additionalProperties: false,
      properties: {
        ...flagBase,
        changes_recorded: nullable("integer", { description: "Transfers recorded, apart from the platform hand-outs made just after a mint." }),
        handouts_recorded: nullable("integer", { description: "Platform hand-outs just after a mint, which are not counted as changes. EVM registries only." }),
        latest_change_block: nullable("integer"),
        ledger_through_block: nullable("integer", { description: "The block the identity ledger is read through." }),
        blocks_since_latest_change: nullable("integer"),
        block_days_since_latest_change: nullable("number", { description: "Robinhood Chain only: blocks divided by 864,000. A proxy, not a date." }),
        latest_change_recorded_at: nullableDateTime,
      },
    },
    revoked_feedback: {
      type: "object",
      description: "Ratings recorded against the agent and how many were later revoked by the rater. Read on Robinhood Chain only.",
      required: ["present", "rating_count", "revoked_count", "revoked_share", "measured_through_block", "basis"],
      additionalProperties: false,
      properties: { ...flagBase, rating_count: nullable("integer"), revoked_count: nullable("integer"), revoked_share: nullable("number", { description: "revoked_count divided by rating_count, to three places. null with no ratings." }), measured_through_block: nullable("integer") },
    },
    fleet: {
      type: "object",
      description: "A fleet means identities registered by one wallet, and nothing more.",
      required: ["present", "listed_by_same_wallet", "same_host_others", "same_name_others", "basis"],
      additionalProperties: false,
      properties: { ...flagBase, listed_by_same_wallet: nullable("integer", { description: "Listings Nooscape shows that this wallet registered, this agent included." }), same_host_others: nullable("integer"), same_name_others: nullable("integer") },
    },
  },
};

const checkResult = {
  type: "object",
  required: ["agent", "evidence", "flags", "sources"],
  additionalProperties: false,
  properties: {
    agent: {
      type: "object",
      required: ["chain", "agent_id", "registry", "nooscape_id", "name", "registrant", "locator_host", "page_url"],
      additionalProperties: false,
      properties: {
        chain: { enum: CHAINS },
        agent_id: { type: "string" },
        registry: { type: "string" },
        nooscape_id: { type: "string" },
        name: { type: "string" },
        registrant: nullable("string"),
        locator_host: nullable("string"),
        page_url: { type: "string" },
      },
    },
    evidence,
    flags: checkFlags,
    sources: {
      type: "object",
      description: "Where each fact was read, and how far each ledger is read through.",
      required: ["registry", "activity_through_block", "ratings_measured_through_block", "registration_read_at"],
      additionalProperties: false,
      properties: {
        registry: { $ref: "#/components/schemas/AgentSource" },
        activity_through_block: nullable("integer", { description: "EVM registries: the block the identity ledger is read through." }),
        ratings_measured_through_block: nullable("integer"),
        registration_read_at: nullableDateTime,
      },
    },
  },
};

const checkRequest = {
  type: "object",
  description: "Give exactly one of agent, wallet or url. chain narrows a wallet or a url.",
  additionalProperties: false,
  properties: {
    agent: {
      type: "object",
      required: ["chain", "id"],
      additionalProperties: false,
      properties: { chain: { enum: CHAINS }, id: { type: "string" }, registry: { enum: ["solana_8004", "solana_said", "solana_registry"] } },
    },
    wallet: { type: "string", description: "A wallet address. The check answers for the listings it registered." },
    url: { type: "string", description: "An endpoint address. Only its host is used, to find listings that registered that host. Nothing is fetched." },
    chain: { enum: CHAINS },
  },
};

const checkResponse = {
  type: "object",
  required: ["api_version", "as_of", "source", "license", "data"],
  additionalProperties: false,
  properties: {
    api_version: { const: "v1" },
    as_of: { ...dateTime, description: "When the check ran." },
    source: { type: "object", required: ["kind", "subject"], additionalProperties: false, properties: { kind: { const: "check" }, subject: { enum: ["agent", "wallet", "url"] } } },
    license: { $ref: "#/components/schemas/License" },
    data: {
      type: "object",
      required: ["subject", "statement", "matched_total", "matched_total_capped", "results"],
      additionalProperties: false,
      properties: {
        subject: {
          type: "object",
          required: ["type", "value", "host"],
          additionalProperties: false,
          properties: { type: { enum: ["agent", "wallet", "url"] }, value: { type: "string" }, host: nullable("string", { description: "For a url, the host that was matched." }) },
        },
        statement: { type: "string", description: "What the facts are and are not: none is a verdict." },
        matched_total: { type: "integer", description: "How many listings were checked. A wallet or url answers for at most 10, newest first." },
        matched_total_capped: { type: "boolean", description: "True when the search page was full, so there may be more listings than were checked." },
        results: { type: "array", items: { $ref: "#/components/schemas/CheckResult" } },
      },
    },
  },
};

const errorResponse = {
  type: "object",
  required: ["error"],
  additionalProperties: false,
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { enum: ["bad_request", "invalid_key", "key_required", "tier_required", "not_found", "ambiguous", "method_not_allowed", "rate_limited", "quota_exceeded", "unavailable"] },
        message: { type: "string" },
        registries: { type: "array", items: { type: "string" }, description: "On ambiguous: the registries that list the address." },
        payment_id: { type: "string", description: "On unavailable, for a payment that has not settled: the id to quote to the operator. Send the same request with the same payment again." },
      },
    },
  },
};

/** What a 402 carries (x402 version 2): the price, and how to pay it. The same document is in the PAYMENT-REQUIRED header, base64 encoded. */
const paymentRequired = {
  type: "object",
  description: "The price of this call and how to pay it, in the x402 format (https://x402.org). Sign the transfer in accepts[0], send it base64 encoded in a PAYMENT-SIGNATURE header, and send the request again.",
  required: ["x402Version", "error", "resource", "accepts", "extensions"],
  additionalProperties: false,
  properties: {
    x402Version: { const: 2 },
    error: { type: "string", description: "Why a payment is asked for, or why the one sent was not taken." },
    resource: {
      type: "object",
      required: ["url", "description", "mimeType"],
      additionalProperties: false,
      properties: { url: { type: "string" }, description: { type: "string" }, mimeType: { type: "string" } },
    },
    accepts: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: {
        type: "object",
        required: ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds", "extra"],
        additionalProperties: false,
        properties: {
          scheme: { const: "exact" },
          network: { type: "string", description: "CAIP-2 chain id: eip155:5042 is Arc mainnet." },
          amount: { type: "string", description: "USDC base units (six decimals): 5000 is $0.005." },
          asset: { type: "string", description: "The USDC contract on that network." },
          payTo: { type: "string", description: "The receiving address. The transfer goes from the caller's wallet to it and Nooscape never holds a caller's funds." },
          maxTimeoutSeconds: { type: "integer" },
          extra: { type: "object", description: "The token's EIP-712 name and version, and the transfer method (eip3009)." },
        },
      },
    },
    extensions: { type: "object", description: "x402 extensions. bazaar says how to call this route: its method, the body or the path parameters, and a JSON Schema they validate against (https://docs.cdp.coinbase.com/x402/seller/get-discovered). It is only a description and changes no price or term." },
  },
};

const envelope = (data: Record<string, unknown>) => ({
  type: "object",
  required: ["api_version", "as_of", "license", "data"],
  additionalProperties: false,
  properties: { api_version: { const: "v1" }, as_of: dateTime, license: { $ref: "#/components/schemas/License" }, data },
});

const watchRow = {
  type: "object",
  required: ["nooscape_id", "chain", "agent_id", "registry", "listed", "watching_since", "page_url"],
  additionalProperties: false,
  properties: {
    nooscape_id: { type: "string", description: "The listing's id on Nooscape. It is what DELETE /api/v1/watches/{nooscape_id} takes." },
    chain: { type: ["string", "null"], enum: WATCH_CHAINS_OR_NULL },
    agent_id: { type: ["string", "null"], description: "The registry token id, or the Solana address." },
    registry: { type: ["string", "null"] },
    listed: { type: "boolean", description: "Whether the listing is in the public view now. A listing that leaves it stays on the list, and an event says so." },
    watching_since: dateTime,
    page_url: { type: "string" },
  },
};

const watchList = envelope({
  type: "object",
  required: ["limit", "watching", "watches"],
  additionalProperties: false,
  properties: { limit: { type: "integer" }, watching: { type: "integer" }, watches: { type: "array", items: watchRow } },
});

const watchAddRequest = {
  type: "object",
  required: ["agents"],
  additionalProperties: false,
  properties: {
    agents: {
      type: "array",
      minItems: 1,
      maxItems: 25,
      items: {
        type: "object",
        required: ["chain", "id"],
        additionalProperties: false,
        properties: { chain: { enum: WATCH_CHAINS }, id: { type: "string" }, registry: { enum: ["solana_8004", "solana_said", "solana_registry"], description: "Solana only, when more than one registry lists the address." } },
      },
    },
  },
};

const watchAddResponse = envelope({
  type: "object",
  required: ["limit", "watching", "results"],
  additionalProperties: false,
  properties: {
    limit: { type: "integer" },
    watching: { type: "integer", description: "How many listings the key watches now." },
    results: {
      type: "array",
      description: "One result for each agent asked for, in the order asked.",
      items: {
        type: "object",
        required: ["chain", "id", "status", "nooscape_id", "message"],
        additionalProperties: false,
        properties: {
          chain: { type: "string" },
          id: { type: "string" },
          status: { enum: ["added", "already_watching", "not_found", "ambiguous", "bad_request", "limit_reached"] },
          nooscape_id: { type: ["string", "null"] },
          message: { type: ["string", "null"] },
        },
      },
    },
  },
});

const watchRemoveResponse = envelope({ type: "object", required: ["removed", "nooscape_id"], additionalProperties: false, properties: { removed: { const: true }, nooscape_id: { type: "string" } } });

const EVENT_NAMES = ["ownership.changed", "feedback.added", "feedback.revoked", "claim.changed", "listing.removed", "listing.restored"];

const webhookRequest = {
  type: "object",
  required: ["url"],
  additionalProperties: false,
  properties: { url: { type: "string", maxLength: 500, description: "An https address on a public name, with no user name, no password and no port. It is checked again before every delivery." } },
};

const webhookResponse = envelope({
  type: "object",
  description: "The key's webhook. With none, configured is false and only the event names follow.",
  required: ["configured", "events"],
  additionalProperties: false,
  properties: {
    configured: { type: "boolean" },
    url: { type: "string" },
    status: { enum: ["active", "off"], description: "off after 20 failed tries in a row. Setting the address again turns it on." },
    off_since: nullableDateTime,
    consecutive_failures: { type: "integer" },
    turned_off_after_failures: { type: "integer" },
    secret_version: { type: "integer" },
    signing_secret: { type: "string", description: "What a delivery's signature is made with: HMAC-SHA256 of the timestamp, a dot and the body. Shown to the key and to nobody else. Rotating it gives a new one." },
    events: { type: "array", items: { enum: [...EVENT_NAMES, "ping"] }, description: "The events a webhook may be sent." },
    created_at: nullableDateTime,
    updated_at: nullableDateTime,
    ping: {
      type: "object",
      description: "Only in the answer to PUT: what the address answered to a test sent when it was set. The address is saved whatever it answered.",
      required: ["ok"],
      additionalProperties: false,
      properties: { ok: { type: "boolean" }, status: { type: ["integer", "null"] }, error: { type: "string" } },
    },
  },
});

const webhookRemoveResponse = envelope({ type: "object", required: ["removed", "configured"], additionalProperties: false, properties: { removed: { type: "boolean" }, configured: { const: false } } });

const webhookDeliveries = envelope({
  type: "object",
  required: ["deliveries"],
  additionalProperties: false,
  properties: {
    deliveries: {
      type: "array",
      description: "The last 20 events written for the key, newest first.",
      items: {
        type: "object",
        required: ["id", "type", "nooscape_id", "status", "attempts", "last_status", "last_error", "next_attempt_at", "created_at", "sent_at"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          type: { enum: EVENT_NAMES },
          nooscape_id: { type: "string" },
          status: { enum: ["pending", "sent", "dead"], description: "dead is given up after six tries." },
          attempts: { type: "integer" },
          last_status: { type: ["integer", "null"], description: "The HTTP status the address answered with on the last try." },
          last_error: { type: ["string", "null"], description: "A short word for why the last try failed, when it did." },
          next_attempt_at: nullableDateTime,
          created_at: dateTime,
          sent_at: nullableDateTime,
        },
      },
    },
  },
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string, description: string) => ({ description, content: { "application/json": { schema: ref(name) } } });
const errors = (...statuses: number[]) =>
  Object.fromEntries(
    statuses.map(status => [
      String(status),
      {
        ...json("Error", { 400: "The request is not valid.", 401: "The key is missing or not valid. A wrong key is refused, not treated as no key.", 403: "The key is valid but its tier does not open this endpoint. The body names the tier that does.", 404: "Nothing listed matches. A hidden, withdrawn or closed record is never served, and looks the same as one that does not exist.", 405: "That method is not one this path takes. The Allow header names the ones it does.", 409: "More than one registry lists that address.", 429: "Over the limit for the minute (rate_limited) or for the day (quota_exceeded). Wait Retry-After seconds.", 503: "The data cannot be read now. Wait Retry-After seconds." }[status] ?? "Error"),
        ...(status === 429 || status === 503 ? { headers: { "Retry-After": { description: "Seconds to wait.", schema: { type: "string" } } } } : {}),
      },
    ])
  );

const rateHeaders = {
  "X-RateLimit-Limit": { description: "Requests allowed per minute from one address.", schema: { type: "string" } },
  "X-RateLimit-Remaining": { description: "Requests left in the current minute.", schema: { type: "string" } },
};

const keyedHeaders = {
  ...rateHeaders,
  "X-Api-Tier": { description: "The key's tier. Sent only with a key.", schema: { type: "string" } },
  "X-Quota-Limit": { description: "Requests the key may make today (UTC). Sent only with a key.", schema: { type: "string" } },
  "X-Quota-Remaining": { description: "Requests the key has left today. Sent only with a key.", schema: { type: "string" } },
  "X-Quota-Reset": { description: "When the day's count restarts. Sent only with a key.", schema: { type: "string" } },
};

/** What a caller with no key may send to pay for a call, and what comes back with the answer. */
const payParameter = { name: "PAYMENT-SIGNATURE", in: "header", description: "A payment for this call (x402, base64 JSON), in answer to a 402. Ignored when the request carries a key, and on a lookup that is within the free limit.", schema: { type: "string" } };
const payResponseHeaders = {
  "PAYMENT-RESPONSE": { description: "Sent when this answer was paid for: base64 JSON with the settlement transaction, the network and the payer.", schema: { type: "string" } },
};
const paymentRequiredResponse = (description: string) => ({
  ...json("PaymentRequired", description),
  headers: { "PAYMENT-REQUIRED": { description: "The same document as the body, base64 encoded.", schema: { type: "string" } } },
});

/** An endpoint the public tier may call, and a key may call with a higher allowance. */
const optionalKey = [{}, { bearerAuth: [] }];
const needsKey = [{ bearerAuth: [] }];

export const API_V1_SPEC = {
  openapi: "3.1.0",
  info: {
    title: "Nooscape API",
    version: "1.0.0",
    summary: "Read-only facts about agents listed in public registries, each with the date it was read.",
    description:
      "Nooscape is an observatory. It reads public agent registries and says what it saw and when. This API changes no record: payment never changes a record, a tier or an evidence level, and nothing here says an agent is safe or unsafe. Agents listed here are acknowledged, not reviewed, and have no tier. Text an owner wrote is shown only as the owner's word. The public tier needs no key and allows 30 requests a minute from one address. A free key raises that to 60 a minute and 1,000 a day, and unlocks a batch lookup, an agent's history and the key's own usage. The pre-flight check needs a Pro key. A Builder or Pro key may watch up to 100 listings and have one https address called when something is recorded about one of them (an ownership change, a rating added or taken back, a claim edit, a listing leaving or returning to the public view): the one thing a key can write is its own watchlist and webhook. An event states a recorded fact with its date, in the words this API already uses. It is signed, is sent at least once, and may arrive out of order. Where pay per call is switched on, a caller with no key may instead pay in USDC on Arc (x402, v2) for a lookup past the free limit and for the check: the transfer goes from the caller's wallet to Nooscape's receiving address, and Nooscape never holds a caller's funds.",
    license: { name: "Provisional terms", url: "https://nooscape.si/terms" },
    contact: { name: "Nooscape", url: "https://nooscape.si/contact" },
  },
  servers: [{ url: "https://nooscape.si" }],
  security: optionalKey,
  paths: {
    "/api/v1/usage": {
      get: { operationId: "getUsage", summary: "What this key has used.", description: "Needs a key. Today's count against the day's allowance, and the last 30 days by endpoint.", security: needsKey, responses: { "200": { ...json("UsageResponse", "The key's usage."), headers: keyedHeaders }, ...errors(401, 429, 503) } },
    },
    "/api/v1/agents/batch": {
      post: {
        operationId: "batchAgents",
        summary: "Up to 25 agents in one request.",
        description: "Needs a key. The body names the agents; each gets its own result and status, so one that is not listed does not spoil the rest. The request counts once against the key's limits.",
        security: needsKey,
        requestBody: { required: true, content: { "application/json": { schema: ref("BatchRequest") } } },
        responses: { "200": { ...json("BatchResponse", "One result for each agent asked for."), headers: keyedHeaders }, ...errors(400, 401, 429, 503) },
      },
    },
    "/api/v1/check": {
      post: {
        operationId: "check",
        summary: "Pre-flight facts for an agent, a wallet or an endpoint URL.",
        description:
          "Needs a Pro key, or a payment for the call (x402): with no key the answer is 402 with the price, and a request that carries a payment is answered like one that carries a Pro key. A payment is charged only for an answer that was built and delivered. Give exactly one of agent, wallet or url. For each listing: the evidence level, four dated flags (first seen, ownership changes, revoked feedback share, fleet size) and the sources they were read from. Facts only: there is no score and no verdict, and a flag that is present is a fact to weigh and not a finding. A wallet or a url answers for the listings it matches exactly, newest first, up to 10. Nothing is fetched from the endpoint. The request counts once against the key's limits.",
        security: [{ bearerAuth: [] }, {}],
        parameters: [payParameter],
        requestBody: { required: true, content: { "application/json": { schema: ref("CheckRequest") } } },
        responses: {
          "200": { ...json("CheckResponse", "The facts for each listing matched."), headers: { ...keyedHeaders, ...payResponseHeaders } },
          "402": paymentRequiredResponse("No key and no payment, or a payment that was not taken. The body is the price and how to pay it; nothing was charged."),
          ...errors(400, 401, 403, 404, 409, 429, 503),
        },
      },
    },
    "/api/v1/watches": {
      get: {
        operationId: "listWatches",
        summary: "The listings this key watches.",
        description: "Needs a Builder or Pro key.",
        security: needsKey,
        responses: { "200": { ...json("WatchList", "The watchlist."), headers: keyedHeaders }, ...errors(401, 403, 429, 503) },
      },
      post: {
        operationId: "addWatches",
        summary: "Watch up to 25 more listings, up to 100 in all.",
        description: "Needs a Builder or Pro key. Each agent gets its own result, so one that is not listed does not spoil the rest. Only what is recorded after a listing is added is sent: nothing is sent for what happened before.",
        security: needsKey,
        requestBody: { required: true, content: { "application/json": { schema: ref("WatchAddRequest") } } },
        responses: { "200": { ...json("WatchAddResponse", "One result for each agent asked for."), headers: keyedHeaders }, ...errors(400, 401, 403, 429, 503) },
      },
    },
    "/api/v1/watches/{nooscape_id}": {
      delete: {
        operationId: "removeWatch",
        summary: "Stop watching a listing.",
        description: "Needs a Builder or Pro key. The id is the nooscape_id the watchlist shows, so a listing that has left the public view can still be removed.",
        security: needsKey,
        parameters: [{ name: "nooscape_id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { ...json("WatchRemoveResponse", "The listing is no longer watched."), headers: keyedHeaders }, ...errors(400, 401, 403, 404, 429, 503) },
      },
    },
    "/api/v1/webhook": {
      get: {
        operationId: "getWebhook",
        summary: "This key's webhook and its signing secret.",
        description: "Needs a Builder or Pro key.",
        security: needsKey,
        responses: { "200": { ...json("WebhookResponse", "The webhook, or that there is none."), headers: keyedHeaders }, ...errors(401, 403, 429, 503) },
      },
      put: {
        operationId: "setWebhook",
        summary: "Set the https address that events are sent to.",
        description:
          "Needs a Builder or Pro key. The address is checked, saved, and sent a test event (type ping) so its owner sees at once whether it is right; it is saved whatever the test got. Setting it again turns a webhook that was turned off back on. A delivery is a POST of a JSON body with X-Nooscape-Event, X-Nooscape-Delivery, X-Nooscape-Timestamp and X-Nooscape-Signature (t=<seconds>,v1=<hex HMAC-SHA256 of the timestamp, a dot and the body, under the signing secret>). Any 2xx answer is a success. A failed try is tried again after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours, and then given up. A redirect is a failure. Changes are limited to 6 a minute.",
        security: needsKey,
        requestBody: { required: true, content: { "application/json": { schema: ref("WebhookRequest") } } },
        responses: { "200": { ...json("WebhookResponse", "The webhook as saved, and what the test got."), headers: keyedHeaders }, ...errors(400, 401, 403, 429, 503) },
      },
      delete: {
        operationId: "removeWebhook",
        summary: "Remove the webhook.",
        description: "Needs a Builder or Pro key. The watchlist stays. The address is erased, and the secret's version number is kept, so a secret that was rotated away does not come back if a webhook is set again.",
        security: needsKey,
        responses: { "200": { ...json("WebhookRemoveResponse", "Whether there was one to remove."), headers: keyedHeaders }, ...errors(401, 403, 429, 503) },
      },
    },
    "/api/v1/webhook/rotate-secret": {
      post: {
        operationId: "rotateWebhookSecret",
        summary: "Give the webhook a new signing secret.",
        description: "Needs a Builder or Pro key. The old secret stops working at once.",
        security: needsKey,
        responses: { "200": { ...json("WebhookResponse", "The webhook with its new secret."), headers: keyedHeaders }, ...errors(401, 403, 404, 429, 503) },
      },
    },
    "/api/v1/webhook/deliveries": {
      get: {
        operationId: "listWebhookDeliveries",
        summary: "The last 20 events written for this key and what became of each.",
        description: "Needs a Builder or Pro key.",
        security: needsKey,
        responses: { "200": { ...json("WebhookDeliveries", "The recent deliveries."), headers: keyedHeaders }, ...errors(401, 403, 429, 503) },
      },
    },
    "/api/v1/agents/{chain}/{id}/history": {
      get: {
        operationId: "getAgentHistory",
        summary: "An agent's registry events and the public history of its claims.",
        description: "Needs a key. The same agent, hidden or not, as the plain lookup: a record the site hides answers 404 here too.",
        security: needsKey,
        parameters: [
          { name: "chain", in: "path", required: true, schema: { enum: CHAINS } },
          { name: "id", in: "path", required: true, description: "The registry token id (digits), or a Solana address.", schema: { type: "string" } },
          { name: "registry", in: "query", description: "Solana only, when more than one registry lists the address.", schema: { enum: ["solana_8004", "solana_said", "solana_registry"] } },
        ],
        responses: { "200": { ...json("HistoryResponse", "The agent's history."), headers: keyedHeaders }, ...errors(400, 401, 404, 409, 429, 503) },
      },
    },
    "/api/v1": {
      get: { operationId: "index", summary: "What this API is, its limits and its endpoints.", responses: { "200": { ...json("IndexResponse", "The API's own description."), headers: keyedHeaders }, ...errors(401, 429) } },
    },
    "/api/v1/openapi.json": {
      get: { operationId: "openapi", summary: "This document.", responses: { "200": { description: "The OpenAPI 3.1 document.", headers: keyedHeaders, content: { "application/json": { schema: { type: "object" } } } }, ...errors(401, 429) } },
    },
    "/api/v1/agents/search": {
      get: {
        operationId: "searchAgents",
        summary: "Search listed agents by name, host, registry key or wallet.",
        description: "Give exactly one of q, owner or host. Results are newest first, up to limit. owner and host are exact filters over the page the search returns. The search covers the Robinhood Chain, BNB Smart Chain and Solana registries.",
        parameters: [
          { name: "q", in: "query", description: "A name, a host, a registry key or a wallet. Two to 64 characters.", schema: { type: "string", minLength: 2, maxLength: 64 } },
          { name: "owner", in: "query", description: "The registering wallet, in full.", schema: { type: "string" } },
          { name: "host", in: "query", description: "The locator host, in full.", schema: { type: "string" } },
          { name: "chain", in: "query", description: "Limit the search to one chain.", schema: { enum: CHAINS } },
          { name: "limit", in: "query", description: "How many results, 1 to 25. Default 10.", schema: { type: "integer", minimum: 1, maximum: 25, default: 10 } },
        ],
        responses: { "200": { ...json("SearchResponse", "A page of results."), headers: keyedHeaders }, ...errors(400, 401, 429, 503) },
      },
    },
    "/api/v1/agents/{chain}/{id}": {
      get: {
        operationId: "getAgent",
        summary: "One agent, by chain and registry id.",
        description: "On robinhood and bnb the id is the registry token id. On solana it is the address. A hidden, withdrawn or closed agent is not served and answers 404 like one that was never listed. Past the free limit a caller with no key may pay for the call (x402) instead of waiting: the answer is 402 with the price, and a payment is charged only for an answer that was built and delivered.",
        parameters: [
          { name: "chain", in: "path", required: true, schema: { enum: CHAINS } },
          { name: "id", in: "path", required: true, description: "The registry token id (digits), or a Solana address.", schema: { type: "string" } },
          { name: "registry", in: "query", description: "Solana only, when more than one registry lists the address (the answer is 409 and names them).", schema: { enum: ["solana_8004", "solana_said", "solana_registry"] } },
          payParameter,
        ],
        responses: {
          "200": { ...json("AgentResponse", "The agent."), headers: { ...keyedHeaders, ...payResponseHeaders } },
          "402": paymentRequiredResponse("Past the free limit with no key. The body is the price and how to pay it; nothing was charged."),
          ...errors(400, 401, 404, 409, 429, 503),
        },
      },
    },
  },
  components: {
    schemas: {
      License: license,
      AgentSource: agentSource,
      Agent: agent,
      AgentResponse: agentResponse,
      SearchResult: searchResult,
      SearchResponse: searchResponse,
      IndexResponse: indexResponse,
      HistoryResponse: historyResponse,
      BatchRequest: batchRequest,
      BatchResponse: batchResponse,
      UsageResponse: usageResponse,
      CheckRequest: checkRequest,
      CheckResult: checkResult,
      CheckResponse: checkResponse,
      PaymentRequired: paymentRequired,
      WatchList: watchList,
      WatchAddRequest: watchAddRequest,
      WatchAddResponse: watchAddResponse,
      WatchRemoveResponse: watchRemoveResponse,
      WebhookRequest: webhookRequest,
      WebhookResponse: webhookResponse,
      WebhookRemoveResponse: webhookRemoveResponse,
      WebhookDeliveries: webhookDeliveries,
      Error: errorResponse,
    },
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "A key from /developers/keys, sent as Authorization: Bearer <key>. Optional on the public endpoints; a key that is wrong is refused with 401." },
    },
  },
} as const;

const REGISTRY_NAMES_TEXT = "The registry Nooscape read the agent from, by its name on Nooscape (erc8004, erc8004_bsc, solana_8004, solana_said, solana_registry).";
const SEARCH_COVERS_TEXT = "The search covers the Robinhood Chain, BNB Smart Chain and Solana registries.";
const ID_TEXT = "On robinhood and bnb the id is the registry token id.";

const listed = (words: readonly string[]) => (words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`);

/** A copy of the document in which each given replacement is made: an array by the object it is, a sentence by its words wherever they occur. */
function withReplacements<T>(node: T, arrays: ReadonlyMap<unknown, unknown>, sentences: ReadonlyMap<string, string>): T {
  if (typeof node === "string") {
    let text: string = node;
    for (const [from, to] of Array.from(sentences)) if (text.includes(from)) text = text.replace(from, to);
    return text as T;
  }
  if (Array.isArray(node)) {
    const swapped = arrays.get(node);
    return (swapped ?? node.map(item => withReplacements(item, arrays, sentences))) as T;
  }
  if (node !== null && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, withReplacements(value, arrays, sentences)])) as T;
  return node;
}

const specs = new Map<string, typeof API_V1_SPEC>();

/**
 * The document for the chains the API serves now (server/apiChains.ts). With Ethereum, Base and Arc all off it is
 * {@link API_V1_SPEC} itself, word for word. With one on, every list of chains names it, and so do the three sentences that name
 * the registries, and so does each list of the watchlist and the webhook, which cover every chain the API serves.
 */
export function apiV1SpecFor(chains: readonly string[]): typeof API_V1_SPEC {
  if (chains.length === CHAINS.length && chains.every((chain, index) => chain === CHAINS[index])) return API_V1_SPEC;
  const key = chains.join(",");
  const known = specs.get(key);
  if (known) return known;
  const extra = chains.filter((chain): chain is ExtraChainKey => chain in EXTRA_CHAIN_LABEL);
  const protocols = extra.map(extraProtocolOf);
  const made = withReplacements(
    API_V1_SPEC,
    new Map<unknown, unknown>([
      [CHAINS, [...chains]],
      [CHAINS_OR_NULL, [...chains, null]],
      [WATCH_CHAINS, [...chains]],
      [WATCH_CHAINS_OR_NULL, [...chains, null]],
    ]),
    new Map([
      [REGISTRY_NAMES_TEXT, `${REGISTRY_NAMES_TEXT.slice(0, -2)}${protocols.map(protocol => `, ${protocol}`).join("")}).`],
      [SEARCH_COVERS_TEXT, `The search covers the ${listed(["Robinhood Chain", "BNB Smart Chain", "Solana", ...extra.map(chain => EXTRA_CHAIN_LABEL[chain])])} registries.`],
      [ID_TEXT, `On ${listed(["robinhood", "bnb", ...extra])} the id is the registry token id.`],
    ]),
  );
  specs.set(key, made);
  return made;
}
