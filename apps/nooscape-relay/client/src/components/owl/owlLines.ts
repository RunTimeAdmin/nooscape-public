/**
 * What the owl says about the record on the Check card, and nothing else. Every line is a template that needs
 * named facts about that record: it exists only while every one of them is present, and says them as they are. There
 * is no line that asserts anything the data does not hold, no verdict and no number of its own. Pure, so all of it
 * is tested without a browser; the tests take each template's facts away one at a time and check the line goes.
 */
export type OwlFacts = {
  /** The record's own id: what the owl has already said about it is remembered by this. */
  key: string;
  /** The evidence tier's label, as the card shows it. */
  tierLabel?: string | null;
  /** How many observations Nooscape keeps of it. Zero is a fact too. */
  observations?: number | null;
  /** When it was last observed (ISO 8601). */
  lastObservedAt?: string | null;
  /** The publisher's state: unverified, allowlisted, expired or revoked. */
  publisher?: string | null;
  /** The chain its registry is on. */
  chain?: string | null;
  /** The name of the source it was read from. */
  source?: string | null;
  /** How many approved sources have seen it. */
  sourceCount?: number | null;
};

export type FactName = Exclude<keyof OwlFacts, "key">;
export type Line = { id: string; text: string };
export type Template = { id: string; needs: readonly FactName[]; say: (facts: OwlFacts, now: Date) => string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", and a date in UTC once it is more than two months back. */
export function agoText(iso: string, now: Date): string {
  const then = new Date(iso);
  const span = now.getTime() - then.getTime();
  if (span < MINUTE) return "just now";
  const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  if (span < HOUR) return plural(Math.floor(span / MINUTE), "minute");
  if (span < 36 * HOUR) return plural(Math.floor(span / HOUR), "hour");
  if (span < 60 * DAY) return plural(Math.floor(span / DAY), "day");
  return `on ${then.getUTCDate()} ${MONTHS[then.getUTCMonth()]} ${then.getUTCFullYear()}`;
}

/** A fact is present when it holds a usable value: a count that is a whole number from zero up, text that says something, a time that reads. */
export function present(facts: OwlFacts, name: FactName, now: Date): boolean {
  const value = facts[name];
  if (value === null || value === undefined) return false;
  if (name === "observations" || name === "sourceCount") return typeof value === "number" && Number.isInteger(value) && value >= 0;
  if (typeof value !== "string" || value.trim() === "") return false;
  if (name === "lastObservedAt") {
    const time = Date.parse(value);
    return !Number.isNaN(time) && time <= now.getTime() + 5 * MINUTE;
  }
  return true;
}

export const TEMPLATES: readonly Template[] = [
  { id: "tier", needs: ["tierLabel"], say: facts => `Evidence on record: ${facts.tierLabel}.` },
  { id: "observations", needs: ["observations"], say: facts => `The Owl has kept ${facts.observations} ${facts.observations === 1 ? "observation" : "observations"} of this one.` },
  { id: "seen", needs: ["lastObservedAt"], say: (facts, now) => `Last seen ${agoText(facts.lastObservedAt!, now)}.` },
  { id: "publisher", needs: ["publisher"], say: facts => `Publisher: ${facts.publisher}.` },
  { id: "chain", needs: ["chain"], say: facts => `Its registry is on ${facts.chain}.` },
  { id: "source", needs: ["source"], say: facts => `Read from ${facts.source}.` },
  { id: "sources", needs: ["sourceCount"], say: facts => `${facts.sourceCount} approved ${facts.sourceCount === 1 ? "source has" : "sources have"} seen it.` },
];

/** Whether the facts hold every fact the template needs, and each usable. */
export function canSay(template: Template, facts: OwlFacts, now: Date): boolean {
  return template.needs.every(name => present(facts, name, now));
}

/** Every line the facts can bear, in the order the templates are written. */
export function linesFor(facts: OwlFacts | null, now: Date): Line[] {
  if (!facts) return [];
  return TEMPLATES.filter(template => canSay(template, facts, now)).map(template => ({ id: template.id, text: template.say(facts, now) }));
}

/** The first line the facts can bear that has not been said yet, or null when there is none. */
export function nextLine(facts: OwlFacts | null, now: Date, said: readonly string[]): Line | null {
  return linesFor(facts, now).find(line => !said.includes(line.id)) ?? null;
}

// ------------------------------------------------------------------- when

/** At most one bubble in this time. */
export const SPEAK_GAP_MS = 8_000;
/** How long a bubble stays. */
export const SHOW_MS = 6_000;
/** The most a bubble waits while the pointer is on it or its button has focus. It always goes by itself. */
export const HOLD_MAX_MS = 20_000;
/** The owl has to have been at rest this long before it speaks, so a pass over a perch says nothing. */
export const SETTLE_MS = 900;
/** After a bubble is dismissed the owl says nothing more about that record for this long. */
export const DISMISS_QUIET_MS = 60_000;

type SpeakInput = {
  now: number;
  /** When the owl came to rest on the perch beside the record, or null while it is not at rest there. */
  restingSince: number | null;
  /** When the last bubble began, or null if none has. */
  lastSpokeAt: number | null;
  /** Until when this record has been asked to be left alone, or null. */
  dismissedUntil: number | null;
  /** A touch screen: the owl says nothing, since the page scrolls under a finger. */
  coarse: boolean;
};

export function maySpeak({ now, restingSince, lastSpokeAt, dismissedUntil, coarse }: SpeakInput): boolean {
  if (coarse || restingSince === null) return false;
  if (now - restingSince < SETTLE_MS) return false;
  if (lastSpokeAt !== null && now - lastSpokeAt < SPEAK_GAP_MS) return false;
  return dismissedUntil === null || now >= dismissedUntil;
}
