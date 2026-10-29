import { normalizeClaimEdit, CLAIM_LIMITS, type ClaimEdit, type ClaimField, type ClaimProfile } from "@shared/claimProfile";
import { arcClaimsOn, baseClaimsOn, ethereumClaimsOn } from "@shared/features";
import { shortWallet } from "@shared/mapFleets";

/**
 * What the "Claim this agent" panel decides and says (docs/claims-2026-10-18.md), kept pure so it can be tested without a browser:
 * which view to show for the state the server gave and the wallet the visitor connected, the edit form turned into the smallest edit
 * that changes what it changed, and the words, in plain language, with the two promises the flow makes (it asks for one signature and
 * nothing else; a claim is the owner's own word and never a review, a tier or a score).
 */

/** What `claim.state` answers. The dates arrive as dates or, after a transport, as text. */
export type ClaimStateView = {
  available: boolean;
  claimable: boolean;
  claim: { status: "active" | "frozen"; wallet: string; claimedAt: Date | string; lastOwnerCheckAt: Date | string; profile: ClaimProfile } | null;
};

type ClaimPanelView = "loading" | "hidden" | "open" | "claimed" | "yours" | "held";

/**
 * The chain name for an entry that can be claimed, or null for any other protocol. The server holds the same (`CLAIM_CHAINS`) and decides.
 * Arc's, Base's and Ethereum's are named only while that chain's claims are on in the build.
 */
export const claimChainLabel = (protocol: string, features: string | undefined = import.meta.env.VITE_FEATURES): string | null =>
  protocol === "erc8004"
    ? "Robinhood Chain"
    : protocol === "erc8004_bsc"
      ? "BNB Smart Chain"
      : protocol === "erc8004_arc" && arcClaimsOn(features)
        ? "Arc"
        : protocol === "erc8004_base" && baseClaimsOn(features)
          ? "Base"
          : protocol === "erc8004_eth" && ethereumClaimsOn(features)
            ? "Ethereum"
            : null;

const sameWallet = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Which view of the panel to show. Nothing at all until the server has answered, and nothing when claims are not available or the
 * entry cannot be claimed. A claim on hold is only on hold. The edit form is for the wallet that holds the claim, and nobody else.
 */
export function claimViewOf(state: ClaimStateView | undefined, connected: string | null): ClaimPanelView {
  if (!state) return "loading";
  if (!state.available || !state.claimable) return "hidden";
  if (!state.claim) return "open";
  if (state.claim.status === "frozen") return "held";
  return connected !== null && sameWallet(connected, state.claim.wallet) ? "yours" : "claimed";
}

// ---------------------------------------------------------------- the edit form

export type ClaimForm = { name: string; website: string; description: string; links: string };

export const EMPTY_FORM: ClaimForm = { name: "", website: "", description: "", links: "" };

/** The form as it starts: what the owner has written, with the links one to a line. */
export const formFromProfile = (profile: ClaimProfile): ClaimForm => ({ name: profile.name ?? "", website: profile.website ?? "", description: profile.description ?? "", links: profile.links.join("\n") });

/** Control and invisible characters out, spaces collapsed, cut to a length: the server does the same and is the one that decides. */
export function cleanText(text: string, maxLength: number): string | null {
  const cleaned = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, maxLength) : null;
}

/** The links box as a list: one to a line, empty lines dropped. */
export const linesOf = (text: string): string[] => text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);

/** Said when the form matches what is already saved: not an error in a field, so the panel shows it beside the button. */
export const NO_CHANGE_LINE = "Change at least one field first.";

type FormResult ={ ok: true; edit: ClaimEdit } | { ok: false; field: ClaimField; message: string };

/**
 * The form as an edit: only the fields that differ from what the owner has written, each cleaned and checked by the same rules the
 * server holds them to. A field emptied becomes a clearing edit. Nothing changed is not an edit.
 */
export function editFromForm(form: ClaimForm, profile: ClaimProfile): FormResult {
  const edit: ClaimEdit = {};
  const textOf = (value: string) => value.trim();
  if (textOf(form.name) !== (profile.name ?? "")) edit.name = textOf(form.name) === "" ? null : textOf(form.name);
  if (textOf(form.website) !== (profile.website ?? "")) edit.website = textOf(form.website) === "" ? null : textOf(form.website);
  if (textOf(form.description) !== (profile.description ?? "")) edit.description = textOf(form.description) === "" ? null : textOf(form.description);
  const links = linesOf(form.links);
  if (JSON.stringify(links) !== JSON.stringify(profile.links)) edit.links = links;
  if (Object.keys(edit).length === 0) return { ok: false, field: "name", message: NO_CHANGE_LINE };
  const checked = normalizeClaimEdit(edit, cleanText);
  return checked.ok ? { ok: true, edit: checked.fields } : { ok: false, field: checked.field, message: checked.message };
}

// ---------------------------------------------------------------- the words

export const CLAIM_HEADING = "Claim this agent";

export const claimIntro = (chainLabel: string) =>
  `If you own this agent's registration on ${chainLabel}, you can claim it. Claiming asks your wallet for one signature, which proves you control the wallet the registry records as the owner.`;

/** What claiming costs and gives away: nothing. The server's message says the same. */
export const NO_COST_LINE = "It sends no transaction, costs no gas, asks for no approval and gives Nooscape no access to your funds.";

/** What a claim is, so no one reads it as more. */
export const CLAIM_MEANS_LINE = "A claim is your own word, shown beside what Nooscape observed. It is not a review, a tier or a score, and it changes nothing about how this entry is listed.";

export const NO_WALLET_LINE = "No browser wallet was found. Open this page in a browser with a wallet extension, then try again.";

export const claimedLine = (wallet: string) => `Claimed by the owner wallet ${shortWallet(wallet)}. Claims are self-described and unverified beyond wallet ownership.`;

export const HELD_LINE = "This claim is on hold.";

export const NOT_HOLDER_LINE = "The connected wallet is not the one that holds this claim.";

/** Said above the message the wallet is about to be asked to sign, so the visitor reads what it is before the wallet shows it. */
export const PREVIEW_CLAIM_LINE = "This is the whole message your wallet will show you. It only proves you own the wallet. No transaction, no gas.";
export const PREVIEW_EDIT_LINE = "This is the whole message your wallet will show you. It only proves you own the wallet and names the change below. No transaction, no gas.";

/**
 * Said above the sign button, with a link to each page: signing from here is the owner acting after reading the Terms for claiming
 * and knowing where what Nooscape keeps is written. The signed message itself carries no terms: it proves control of a wallet only.
 */
export const NOTICE = { before: "By claiming you agree to the ", terms: "Terms for claiming", middle: ". What Nooscape keeps is on the ", privacy: "Privacy page", after: "." } as const;
export const noticeText = () => `${NOTICE.before}${NOTICE.terms}${NOTICE.middle}${NOTICE.privacy}${NOTICE.after}`;

/** What a visitor is told when a call to the server fails with text the server did not write (a malformed request, a crash). */
export const GENERIC_ERROR_LINE = "That did not work. Try again in a few minutes.";

/** The server's own answers are short plain sentences; anything shaped like data is not shown. */
export const serverErrorMessage = (message: unknown): string =>
  typeof message === "string" && message.length > 0 && message.length <= 300 && !/^[[{]/.test(message) ? message : GENERIC_ERROR_LINE;

/** When the registry was last asked who owns the agent, as the page words it. `when` is the date already formatted for the viewer. */
export const lastCheckedLine = (when: string) => `The registry was last asked who owns this agent on ${when}. If the agent changes hands, the claim ends.`;

export const FIELD_HINTS = {
  name: `Up to ${CLAIM_LIMITS.name} characters.`,
  website: "An https address on a public site.",
  description: `Up to ${CLAIM_LIMITS.description} characters.`,
  links: `Up to ${CLAIM_LIMITS.links} https addresses, one to a line.`,
} as const;

/** What the panel says is happening, for a screen reader and for the visitor. */
export type ClaimStep = "idle" | "connecting" | "requesting" | "signing" | "checking" | "done";
export const STEP_LABEL: Record<ClaimStep, string> = {
  idle: "",
  connecting: "Waiting for your wallet to share an account…",
  requesting: "Asking Nooscape for the message to sign…",
  signing: "Waiting for your signature in your wallet…",
  checking: "Checking with the registry…",
  done: "Done.",
};

// ---------------------------------------------------------------- what the owner wrote, and the history

export const OWNER_TEXT_LABEL = "What the owner wrote";
export const OWNER_TEXT_NOTE = "Written by the claim holder. Nooscape has not checked it, and it does not change how this entry is listed.";
export const HISTORY_LABEL = "Claim history";
export const HISTORY_NOTE = "Each change is added and none is edited. If text was removed from view, or the claim is on hold, an entry says that a change was made, not what it said.";
export const TEXT_NOT_SHOWN = "The text is not shown.";

export const FIELD_LABEL: Record<ClaimField, string> = { name: "name", website: "website", description: "description", links: "links" };

/** An address as a link target: only an https address is one, so owner-written text can never carry a script or another scheme into a link. */
export function safeHttpsHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0 ? url.href : null;
  } catch {
    return null;
  }
}

/** What an owner's link carries: no search engine credit, no opener, and it says it is user-written. */
export const OWNER_LINK_REL = "nofollow ugc noopener noreferrer";

/** What the history API answers for one row. The time arrives as a date or, after a transport, as text. */
export type ClaimHistoryView = {
  seq: number;
  kind: "claim" | "edit" | "freeze" | "unfreeze" | "revoke" | "redact";
  field: ClaimField | null;
  oldValue: string | null;
  newValue: string | null;
  withheld: boolean;
  wallet: string | null;
  signatureDigest: string | null;
  reason: string | null;
  occurredAt: Date | string;
};

/** The history is stored with the links as a JSON list; as it is read they are the addresses, one after another. */
export function readableValue(field: ClaimField | null, value: string): string {
  if (field !== "links") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").join(", ") : value;
  } catch {
    return value;
  }
}

export const historySummary = (count: number) => `${count} ${count === 1 ? "entry" : "entries"}`;

type HistoryLine = { title: string; change: string | null; signed: string | null };

const signedBy = (item: ClaimHistoryView) =>
  item.wallet ? `Signed by ${shortWallet(item.wallet)}${item.signatureDigest ? `, signature digest ${item.signatureDigest.slice(0, 12)}…` : ""}.` : null;

/** One row of the history in plain words, without its time (the page formats that for the viewer). */
export function historyLine(item: ClaimHistoryView): HistoryLine {
  switch (item.kind) {
    case "claim":
      return { title: "Claimed", change: null, signed: signedBy(item) };
    case "edit": {
      const field = item.field ? FIELD_LABEL[item.field] : "text";
      let change: string;
      if (item.withheld) change = TEXT_NOT_SHOWN;
      else if (item.newValue === null && item.oldValue !== null) change = `Cleared. It was: ${readableValue(item.field, item.oldValue)}`;
      else if (item.oldValue === null && item.newValue !== null) change = `Set to: ${readableValue(item.field, item.newValue)}`;
      else if (item.oldValue !== null && item.newValue !== null) change = `Changed from: ${readableValue(item.field, item.oldValue)}\nTo: ${readableValue(item.field, item.newValue)}`;
      else change = TEXT_NOT_SHOWN;
      return { title: `Changed the ${field}`, change, signed: signedBy(item) };
    }
    case "redact": {
      // Who asked, never why: the reason stays in the private record.
      const by = item.reason === "owner_request" ? " at the owner's request" : item.reason === "nooscape" ? " by Nooscape" : "";
      return { title: `Removed the ${item.field ? FIELD_LABEL[item.field] : "text"} from view${by}`, change: null, signed: null };
    }
    case "freeze":
      return { title: "Put on hold", change: "While a claim is on hold, nothing the owner wrote is shown and the claim cannot be edited.", signed: null };
    case "unfreeze":
      return { title: "Taken off hold", change: null, signed: null };
    case "revoke":
      return {
        title: "The claim ended",
        change: item.reason === "owner_changed" ? "The registry shows a new owner." : item.reason === "token_gone" ? "The registry no longer shows an owner." : null,
        signed: null,
      };
  }
}

/** The operator's box takes an entry's id or the address of its page. */
export function entryIdFrom(text: string): string {
  const trimmed = text.trim();
  const match = /\/agents\/([^/?#\s]+)/.exec(trimmed);
  return match ? match[1]! : trimmed;
}
