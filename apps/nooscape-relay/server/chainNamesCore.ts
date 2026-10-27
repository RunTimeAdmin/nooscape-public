import { externalKey } from "./ingestion/erc8004Chain";
import { ARC_CHAIN, BASE_CHAIN, ETHEREUM_CHAIN, type Erc8004Chain } from "./ingestion/erc8004Chains";
import { sanitizePublicText } from "./publicText";
import { ENTRY_PLACEHOLDER_PATTERN, SHOWN_NAME_MAX_CHARS } from "./robinhoodNamesCore";

/**
 * The pure rules of the Base, Arc and Ethereum name step (docs/approvals/2026-10-26-base-arc-names.md, extended to Ethereum on
 * 2026-10-27). A registration on these chains that carries no name of its own inside its link is called "Agent #<n>". The step reads
 * the link from the chain, reads the file the link names, and lays the name it finds over the placeholder of the registration's
 * directory entry. Nothing here touches the network or the database.
 */

/**
 * The chains the step names, in the order it takes its turns. Robinhood Chain has a step of its own (robinhoodNames.ts), and the
 * BNB Chain registration files keep no name (docs/approvals/2026-10-17-bnb-registration-files.md), so neither is here.
 */
export const NAME_CHAINS: readonly Erc8004Chain[] = [BASE_CHAIN, ARC_CHAIN, ETHEREUM_CHAIN];

/** The agent id in a directory key of this chain (`eip155:<chain id>:<registry>:<agent id>`), or null for a key of any other shape. */
export function agentIdOfKey(chain: Erc8004Chain, key: string): string | null {
  const prefix = externalKey(chain, "");
  if (!key.startsWith(prefix)) return null;
  const id = key.slice(prefix.length);
  return /^[0-9]{1,18}$/.test(id) ? id : null;
}

/** Orders two directory keys of one chain, the newest registration (the highest agent id) first. */
export function newestKeyFirst(a: string, b: string): number {
  const x = a.slice(a.lastIndexOf(":") + 1);
  const y = b.slice(b.lastIndexOf(":") + 1);
  return y.length - x.length || (x < y ? 1 : x > y ? -1 : 0);
}

// Case-insensitive because MySQL's REGEXP is under the tables' collation: a name the database still reads as the placeholder must not be written.
const PLACEHOLDER = new RegExp(ENTRY_PLACEHOLDER_PATTERN, "i");
const ONLY_A_NUMBER = /^[0-9]+$/;

/**
 * The name to show for a name that was read, or null when there is none worth showing: it cleans to nothing, it is only a number
 * (the listing rules hold such a registration out, so a listed entry does not take one: server/agentRegistryRows.ts), or it reads
 * "Agent #<n>", which says nothing the placeholder does not and would leave the entry looking unnamed.
 */
export function usableName(raw: string): string | null {
  const name = sanitizePublicText(raw, SHOWN_NAME_MAX_CHARS);
  if (name === null || ONLY_A_NUMBER.test(name) || PLACEHOLDER.test(name)) return null;
  return name;
}
