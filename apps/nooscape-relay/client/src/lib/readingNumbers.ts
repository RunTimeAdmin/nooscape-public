import { CHAIN_LABEL } from "@shared/chains";
import { LIGHT_CHAIN_ORDER } from "@shared/noosphere";

/**
 * The words under "Reading the numbers" on /about. One site shows several totals because each counts something else, and a
 * reader who adds up the chain tabs and meets another figure on the home page cannot tell why. The meanings are here in one place,
 * with the figure beside the two that Nooscape counts for the whole site. A term with no figure of its own leaves `figure` out; a
 * figure that has not been read yet is null, and the page shows it as a pause, never as a zero.
 */
export type NumberMeaning = { term: string; meaning: string; figure?: number | null };

/** "A", "A and B", "A, B and C". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The chains the map on the home page draws, named from the same list the map is drawn from. */
export function mapChainNames(): string {
  return joinNames(LIGHT_CHAIN_ORDER.flatMap(chain => (chain === null ? [] : [CHAIN_LABEL[chain]])));
}

export function readingTheNumbers(figures: { listed: number | null; reviewed: number | null }): NumberMeaning[] {
  return [
    {
      term: "Listed, also called acknowledged",
      figure: figures.listed,
      meaning:
        "Agents the directory shows from the chain registries under the published listing rules: a source saw the agent, and Nooscape kept its name, where it was seen and the source's own key. It is not a count of the agents that exist, and it is not a review.",
    },
    {
      term: "Reviewed",
      figure: figures.reviewed,
      meaning: "Records whose evidence Nooscape read, kept and signed, with the level it cleared. Most listed agents are not reviewed, and a listed agent has no tier.",
    },
    {
      term: "Registered on chain",
      meaning:
        "What a chain's registry holds. Where Nooscape counts it, it is larger than the listed figure, because registrations the listing rules hold out, such as a flood from one wallet, are not listed. Held out is not judged.",
    },
    {
      term: "New in the last day",
      meaning: "Entries Nooscape saw for the first time in the last day, new_in_24h in the API. It says when Nooscape saw an entry, not when the agent was made.",
    },
    {
      term: "On the map",
      meaning: `The lights on the home page draw ${mapChainNames()} only, so the count under the map is smaller than the listed figure.`,
    },
  ];
}
