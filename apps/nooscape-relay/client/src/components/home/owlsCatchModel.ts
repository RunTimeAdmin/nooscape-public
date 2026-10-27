import { ARCHIVE_PATH, ARCHIVE_TITLE, catchPath, catchUrl, dateLabel, dayTitle, SITE_ORIGIN, type PublicCatch } from "@shared/owlsCatch";

/**
 * What the Owl's Catch card and pages say and link to, decided apart from how they are drawn so none of it needs a
 * browser to test. The catch itself (its headline, detail and how-we-know text) is built on the server from the
 * stored facts, so nothing here makes up a figure: this only picks what to show when there is a catch, when there
 * is none, and when the read has not come back, and builds the links. The paths, the day's label and the page
 * titles are the shared ones, which the server also uses to write the page's head.
 */
export { ARCHIVE_PATH, ARCHIVE_TITLE, catchPath, catchUrl, dateLabel, dayTitle, SITE_ORIGIN };

export const agentPath = (id: string) => `/agents/${encodeURIComponent(id)}`;

/** How many of a fleet's identities the card links to. */
export const LINKS_SHOWN = 5;

type Shareable = Pick<PublicCatch, "date" | "headline">;

/** The post a share starts with: the day and the headline, which is all the catch says. The link carries the rest. */
export const shareText = (view: Shareable) => `The Owl's Catch, ${dateLabel(view.date)}: ${view.headline}`;

/** X's share link: no script and no SDK, a plain link that opens X with the post already written. */
export const shareHref = (view: Shareable) => `https://x.com/intent/post?text=${encodeURIComponent(shareText(view))}&url=${encodeURIComponent(catchUrl(view.date))}`;

/** The identities a card links to: the first few, in the order the catch stored them. */
export const linkedAgents = (view: Pick<PublicCatch, "agents">) => view.agents.slice(0, LINKS_SHOWN);

type QuietReason = "none" | "pending" | "unavailable";

/** What the card says when there is no catch to show. Plain statements of what is true; nothing stands in for a catch. */
export const QUIET_COPY: Record<QuietReason, { title: string; detail: string }> = {
  none: { title: "No catch today", detail: "No count passed the Owl's rules today, so it reports nothing." },
  pending: { title: "Today's catch is not chosen yet", detail: "The Owl chooses it on the first check after midnight UTC." },
  unavailable: { title: "The catch cannot be read right now", detail: "Nothing is shown in its place." },
};

export type TodaysCatchPayload = {
  date: string;
  status: "selected" | "none" | "pending" | "unavailable";
  today: PublicCatch | null;
  latest: PublicCatch | null;
};

type CardState =
  | { kind: "loading" }
  | { kind: "catch"; view: PublicCatch }
  | { kind: "quiet"; reason: QuietReason; latest: PublicCatch | null };

/** Which of the card's states the read puts it in. A day that says it has a catch but does not hold one is shown as unreadable, never as empty. */
export function cardState(query: { isLoading: boolean; isError: boolean; data: TodaysCatchPayload | undefined }): CardState {
  if (query.isLoading) return { kind: "loading" };
  const data = query.data;
  if (query.isError || !data) return { kind: "quiet", reason: "unavailable", latest: null };
  if (data.status === "selected") return data.today ? { kind: "catch", view: data.today } : { kind: "quiet", reason: "unavailable", latest: data.latest };
  return { kind: "quiet", reason: data.status, latest: data.status === "unavailable" ? null : data.latest };
}

/** Whether a catch is the one chosen for the date the read called today. */
export const isToday = (view: Pick<PublicCatch, "date">, today: string) => view.date === today;
