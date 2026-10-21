import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { InfoPage, headingClass, linkClass, listClass, textClass } from "@/components/InfoPage";
import { serverErrorMessage } from "@/lib/claimFlow";
import { formatWhen } from "@/lib/checkText";
import { SUPPORT_EMAIL } from "@/lib/contacts";
import {
  curlFor,
  CHECK_TIER_LINE,
  EMAIL_USE_LINE,
  endpointsLine,
  fetchUsage,
  KEEP_SAFE_LINE,
  KEY_UNLOCKS,
  KeyLookupError,
  looksLikeKey,
  NEVER_CHANGES_LINE,
  NOTHING_SAVED_LINE,
  PAID_TIERS_LINE,
  SHOWN_ONCE_LINE,
  tierLines,
  USAGE_COUNTS_LINE,
  type UsageView,
} from "@/lib/apiKeysFlow";
import { trpc } from "@/lib/trpc";

/**
 * Get an API key, see what it has used, end it (docs/data-access-2026-10-19.md, stage D2). A free key is made from an email and shown
 * once. The page saves nothing in the browser. A key's use is read from the public API with the key, as any caller would, and ending a
 * key goes through the site's server. The paid tiers are arranged by email; nothing on this page takes a payment.
 */
const card = "mt-4 max-w-2xl rounded-2xl border border-[var(--ns-glass-border)] bg-[var(--ns-glass)] p-5 sm:p-6";
const note = "max-w-2xl text-sm leading-6 text-ns-ink-dim";
const pill =
  "inline-flex min-h-11 items-center gap-2 rounded-full border border-ns-radar/40 bg-ns-radar/10 px-4 font-mono text-xs uppercase tracking-[.14em] text-ns-radar transition hover:bg-ns-radar hover:text-ns-void focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ns-radar disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-ns-radar/10 disabled:hover:text-ns-radar";
const quiet =
  "inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-[.14em] text-ns-ink-dim underline underline-offset-4 hover:text-ns-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ns-radar disabled:opacity-50";
const input =
  "mt-1 w-full rounded-xl border border-[var(--ns-glass-border)] bg-white/[.04] px-3 py-2 text-sm text-ns-ink placeholder:text-ns-ink-dim focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ns-radar disabled:opacity-60";

type Made = { key: string; tier: string };

const messageOf = (error: unknown) => serverErrorMessage(error instanceof Error ? error.message : undefined);

export default function DeveloperKeys() {
  const create = trpc.apiKeys.create.useMutation();
  const revoke = trpc.apiKeys.revoke.useMutation();
  const [email, setEmail] = useState("");
  const [made, setMade] = useState<Made | null>(null);
  const [makeError, setMakeError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const [lookup, setLookup] = useState("");
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [usageFor, setUsageFor] = useState("");
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ended, setEnded] = useState<string | null>(null);
  const [endError, setEndError] = useState<string | null>(null);
  const madeRef = useRef<HTMLDivElement>(null);
  const origin = typeof window === "undefined" ? "https://nooscape.si" : window.location.origin;

  useEffect(() => {
    if (made) madeRef.current?.focus();
  }, [made]);

  async function makeKey(event: FormEvent) {
    event.preventDefault();
    setMakeError(null);
    setCopied(null);
    try {
      const result = await create.mutateAsync({ email: email.trim() });
      setMade({ key: result.key, tier: result.tier });
      setEmail("");
      setEnded(null);
    } catch (error) {
      setMakeError(messageOf(error));
    }
  }

  async function copyKey() {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.key);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
  }

  async function look(key: string) {
    setLookupError(null);
    setEndError(null);
    setConfirmEnd(false);
    setEnded(null);
    setUsage(null);
    if (!looksLikeKey(key)) {
      setLookupError("That is not an API key. A key starts with nsk_ and is 44 characters long.");
      return;
    }
    setLooking(true);
    try {
      setUsage(await fetchUsage(key));
      setUsageFor(key.trim());
    } catch (error) {
      setLookupError(error instanceof KeyLookupError ? error.message : messageOf(error));
    } finally {
      setLooking(false);
    }
  }

  async function endKey() {
    setEndError(null);
    try {
      const result = await revoke.mutateAsync({ key: usageFor });
      setEnded(result.prefix);
      setUsage(null);
      setUsageFor("");
      setLookup("");
      setConfirmEnd(false);
      if (made && made.key.startsWith(result.prefix)) setMade(null);
    } catch (error) {
      setEndError(messageOf(error));
    }
  }

  return (
    <InfoPage title="API keys" eyebrow="Developers" heading="API keys">
      <p className={textClass}>
        The <Link href="/developers" className={linkClass}>public API</Link> needs no key. A key raises how much you can ask and opens a few more calls. {NEVER_CHANGES_LINE}
      </p>

      <section aria-labelledby="keys-tiers">
        <h2 id="keys-tiers" className={headingClass}>What a key allows</h2>
        <ul className={listClass}>
          <li>No key: 30 requests a minute from one address.</li>
          {tierLines().map(tier => (
            <li key={tier.tier}>
              {tier.label}: {tier.line}.
            </li>
          ))}
        </ul>
        <p className={textClass}>A key also opens:</p>
        <ul className={listClass}>
          {KEY_UNLOCKS.map(line => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className={textClass}>
          {PAID_TIERS_LINE} {CHECK_TIER_LINE} Write to <a href={`mailto:${SUPPORT_EMAIL}`} className={linkClass}>{SUPPORT_EMAIL}</a>.
        </p>
      </section>

      <section aria-labelledby="keys-make">
        <h2 id="keys-make" className={headingClass}>Make a free key</h2>
        <div className={card}>
          <form onSubmit={event => void makeKey(event)} className="space-y-3" noValidate>
            <div>
              <label htmlFor="key-email" className="eyebrow">Email</label>
              <input id="key-email" className={input} type="email" inputMode="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} aria-describedby="key-email-hint" disabled={create.isPending} />
              <p id="key-email-hint" className="mt-1 text-xs text-ns-ink-dim">{EMAIL_USE_LINE}</p>
            </div>
            <button type="submit" className={pill} disabled={create.isPending || email.trim().length === 0}>
              {create.isPending ? "Making the key…" : "Make a key"}
            </button>
          </form>
          {makeError && <p role="alert" className="mt-4 max-w-2xl text-sm leading-6 text-[#FFB4A8]">{makeError}</p>}
        </div>
        <p className={`${note} mt-3`}>
          An email may hold up to three live keys. See <Link href="/privacy" className={linkClass}>Privacy</Link> for what is kept and <Link href="/terms" className={linkClass}>Terms</Link> for how a key may be used.
        </p>

        {made && (
          <div ref={madeRef} tabIndex={-1} className={`${card} outline-none`} aria-labelledby="key-made-title">
            <h3 id="key-made-title" className="eyebrow">Your {made.tier} key</h3>
            <p className="mt-3 break-all rounded-xl border border-[var(--ns-glass-border)] bg-black/30 p-4 font-mono text-sm leading-6 text-ns-ink select-all" data-testid="new-key">{made.key}</p>
            <p className={`${note} mt-3`}>{SHOWN_ONCE_LINE}</p>
            <p className={note}>{KEEP_SAFE_LINE}</p>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
              <button type="button" className={pill} onClick={() => void copyKey()}>Copy the key</button>
              <button type="button" className={quiet} onClick={() => { setLookup(made.key); void look(made.key); }} disabled={looking}>Look up its use</button>
            </div>
            <div role="status" aria-live="polite" className="text-sm text-ns-ink-dim [&:not(:empty)]:mt-3">
              {copied === "yes" ? "Copied." : copied === "no" ? "Your browser would not copy it. Select the key above and copy it by hand." : ""}
            </div>
            <p className="mt-4 text-xs uppercase tracking-[.14em] text-ns-ink-dim">Try it</p>
            <pre className="mt-2 overflow-x-auto whitespace-pre rounded-xl border border-[var(--ns-glass-border)] bg-black/30 p-4 font-mono text-xs leading-5 text-ns-ink">{curlFor(made.key, origin)}</pre>
            <p className={`${note} mt-3`}>{NOTHING_SAVED_LINE}</p>
          </div>
        )}
      </section>

      <section aria-labelledby="keys-use">
        <h2 id="keys-use" className={headingClass}>See what a key has used, or end it</h2>
        <div className={card}>
          <form
            onSubmit={event => {
              event.preventDefault();
              void look(lookup);
            }}
            className="space-y-3"
            noValidate
          >
            <div>
              <label htmlFor="key-lookup" className="eyebrow">Key</label>
              <input id="key-lookup" className={`${input} font-mono`} type="password" autoComplete="off" spellCheck={false} value={lookup} onChange={event => setLookup(event.target.value)} aria-describedby="key-lookup-hint" disabled={looking} />
              <p id="key-lookup-hint" className="mt-1 text-xs text-ns-ink-dim">{USAGE_COUNTS_LINE}</p>
            </div>
            <button type="submit" className={pill} disabled={looking || lookup.trim().length === 0}>
              {looking ? "Looking…" : "Show its use"}
            </button>
          </form>
          {lookupError && <p role="alert" className="mt-4 max-w-2xl text-sm leading-6 text-[#FFB4A8]">{lookupError}</p>}
        </div>

        {ended && (
          <p role="status" className={`${note} mt-4`}>
            The key {ended}… has been ended. It stopped working at once.
          </p>
        )}

        {usage && (
          <div className={card} aria-labelledby="key-usage-title">
            <h3 id="key-usage-title" className="eyebrow">Key {usage.prefix}…</h3>
            <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 text-sm text-ns-ink sm:grid-cols-2">
              <div><dt className="text-ns-ink-dim">Tier</dt><dd>{usage.tier}</dd></div>
              <div><dt className="text-ns-ink-dim">Limits</dt><dd>{usage.perMinute.toLocaleString("en-US")} a minute, {usage.perDay.toLocaleString("en-US")} a day</dd></div>
              <div><dt className="text-ns-ink-dim">Used today (UTC)</dt><dd>{usage.today.used.toLocaleString("en-US")} of {usage.today.limit.toLocaleString("en-US")}, {usage.today.remaining.toLocaleString("en-US")} left</dd></div>
              <div><dt className="text-ns-ink-dim">The count restarts</dt><dd>{formatWhen(usage.today.resetsAt)}</dd></div>
            </dl>
            <h4 className="eyebrow mt-5">Last 30 days</h4>
            {usage.days.length === 0 ? (
              <p className={`${note} mt-2`}>Nothing has been counted for this key yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-white/[.08] text-sm text-ns-ink">
                {usage.days.map(day => (
                  <li key={day.date} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                    <span className="font-mono">{day.date}</span>
                    <span>{day.total.toLocaleString("en-US")}</span>
                    <span className="basis-full text-xs text-ns-ink-dim sm:basis-auto">{endpointsLine(day.byEndpoint)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className={`${note} mt-3`}>Counts reach this list within about half a minute.</p>
            <div className="mt-4">
              {confirmEnd ? (
                <div className="space-y-3">
                  <p className={note}>End the key {usage.prefix}…? It stops working at once and cannot be turned back on. You can make another.</p>
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    <button type="button" className={pill} disabled={revoke.isPending} onClick={() => void endKey()}>
                      {revoke.isPending ? "Ending…" : "End the key"}
                    </button>
                    <button type="button" className={quiet} disabled={revoke.isPending} onClick={() => setConfirmEnd(false)}>Keep it</button>
                  </div>
                </div>
              ) : (
                <button type="button" className={quiet} onClick={() => setConfirmEnd(true)}>End this key</button>
              )}
              {endError && <p role="alert" className="mt-3 max-w-2xl text-sm leading-6 text-[#FFB4A8]">{endError}</p>}
            </div>
          </div>
        )}
      </section>
    </InfoPage>
  );
}
