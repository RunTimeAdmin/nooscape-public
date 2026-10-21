import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ClaimEdit, ClaimField } from "@shared/claimProfile";
import { formatWhen } from "@/lib/checkText";
import {
  CLAIM_HEADING,
  CLAIM_MEANS_LINE,
  claimedLine,
  claimIntro,
  claimViewOf,
  editFromForm,
  EMPTY_FORM,
  FIELD_HINTS,
  formFromProfile,
  HELD_LINE,
  lastCheckedLine,
  NO_CHANGE_LINE,
  NO_COST_LINE,
  NO_WALLET_LINE,
  NOT_HOLDER_LINE,
  NOTICE,
  PREVIEW_CLAIM_LINE,
  PREVIEW_EDIT_LINE,
  serverErrorMessage,
  STEP_LABEL,
  type ClaimForm,
  type ClaimStep,
} from "@/lib/claimFlow";
import { trpc } from "@/lib/trpc";
import { ClaimHistory } from "./ClaimHistory";
import { OwnerText } from "./OwnerText";
import { discoverWallets, requestAddress, signMessage, walletErrorMessage, type WalletInfo } from "@/lib/wallet";

/**
 * "Claim this agent" on an entry's page (docs/claims-2026-10-18.md). Nothing here touches a wallet until a visitor presses a button, and
 * nothing is kept in the browser: the connected account lives in this component and goes when the page does. The wallet is asked for
 * its account and for one signature, on a message that is shown in full first. It is never asked to send a transaction.
 */
const card = "rounded-2xl border border-[var(--ns-glass-border)] bg-[var(--ns-glass)] p-5 sm:p-6";
const note = "max-w-2xl text-sm leading-6 text-ns-ink-dim";
const pill =
  "inline-flex min-h-11 items-center gap-2 rounded-full border border-ns-radar/40 bg-ns-radar/10 px-4 font-mono text-xs uppercase tracking-[.14em] text-ns-radar transition hover:bg-ns-radar hover:text-ns-void focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ns-radar disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-ns-radar/10 disabled:hover:text-ns-radar";
const quiet =
  "inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-[.14em] text-ns-ink-dim underline underline-offset-4 hover:text-ns-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ns-radar disabled:opacity-50";
const textLink =
  "text-ns-ink underline decoration-ns-radar/50 underline-offset-4 transition hover:decoration-ns-radar focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ns-radar";
const input =
  "mt-1 w-full rounded-xl border border-[var(--ns-glass-border)] bg-white/[.04] px-3 py-2 text-sm text-ns-ink placeholder:text-ns-ink-dim focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ns-radar disabled:opacity-60";

type Connected = { address: string; wallet: WalletInfo };
type Prepared = { nonce: string; message: string; action: "claim" | "edit"; edit?: ClaimEdit };

const messageOf = (error: unknown) => serverErrorMessage(error instanceof Error ? error.message : undefined);

export function ClaimPanel({ entryId, chainLabel }: { entryId: string; chainLabel: string }) {
  const utils = trpc.useUtils();
  const stateQuery = trpc.claim.state.useQuery({ entryId }, { refetchOnWindowFocus: false, retry: false });
  const issue = trpc.claim.nonce.useMutation();
  const verify = trpc.claim.verify.useMutation();
  const edit = trpc.claim.edit.useMutation();

  const [choices, setChoices] = useState<WalletInfo[] | null>(null);
  const [connected, setConnected] = useState<Connected | null>(null);
  const [step, setStep] = useState<ClaimStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [form, setForm] = useState<ClaimForm>(EMPTY_FORM);
  const [fieldError, setFieldError] = useState<{ field: ClaimField; message: string } | null>(null);

  const state = stateQuery.data;
  const view = claimViewOf(state, connected?.address ?? null);
  const claim = state?.claim ?? null;
  const busy = step !== "idle";

  // The form starts from what the owner has saved, and starts again from the new text once an edit is saved.
  const savedKey = claim ? JSON.stringify(claim.profile) : "";
  useEffect(() => {
    if (claim) setForm(formFromProfile(claim.profile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  // The button that asked for the message goes when the message appears, so the keyboard lands on the next step.
  const signButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (prepared) signButton.current?.focus();
  }, [prepared]);

  if (stateQuery.isError || view === "loading" || view === "hidden") return null;

  async function connect() {
    setError(null);
    setNotice(null);
    setStep("connecting");
    try {
      const wallets = await discoverWallets(window);
      if (wallets.length === 0) setError(NO_WALLET_LINE);
      else if (wallets.length === 1) await connectTo(wallets[0]!);
      else setChoices(wallets);
    } finally {
      setStep("idle");
    }
  }

  async function connectTo(wallet: WalletInfo) {
    setChoices(null);
    setError(null);
    setStep("connecting");
    try {
      setConnected({ address: await requestAddress(wallet.provider), wallet });
    } catch (failure) {
      setError(walletErrorMessage(failure));
    } finally {
      setStep("idle");
    }
  }

  function disconnect() {
    setConnected(null);
    setChoices(null);
    setPrepared(null);
    setError(null);
    setNotice(null);
  }

  async function prepare(action: "claim" | "edit", change?: ClaimEdit) {
    if (!connected) return;
    setError(null);
    setNotice(null);
    setStep("requesting");
    try {
      const issued = await issue.mutateAsync({ entryId, wallet: connected.address, action, ...(change ? { edit: change } : {}) });
      setPrepared({ nonce: issued.nonce, message: issued.message, action, ...(change ? { edit: change } : {}) });
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setStep("idle");
    }
  }

  async function sign() {
    if (!connected || !prepared) return;
    setError(null);
    setStep("signing");
    let signature: string;
    try {
      signature = await signMessage(connected.wallet.provider, prepared.message, connected.address);
    } catch (failure) {
      setError(walletErrorMessage(failure));
      setStep("idle");
      return;
    }
    setStep("checking");
    try {
      if (prepared.action === "claim") {
        await verify.mutateAsync({ nonce: prepared.nonce, message: prepared.message, signature });
        setNotice("Claimed. The wallet you signed with now holds this claim.");
      } else {
        const done = await edit.mutateAsync({ nonce: prepared.nonce, message: prepared.message, signature, edit: prepared.edit ?? {} });
        setNotice(done.changed === 0 ? "Saved. Nothing changed." : `Saved. ${done.changed} ${done.changed === 1 ? "field" : "fields"} changed.`);
      }
      await Promise.all([utils.claim.state.invalidate({ entryId }), utils.claim.history.invalidate({ entryId })]);
    } catch (failure) {
      // A message that failed its checks is spent: the visitor starts again for a new one.
      setError(messageOf(failure));
    } finally {
      setPrepared(null);
      setStep("idle");
    }
  }

  function review(event: FormEvent) {
    event.preventDefault();
    if (!claim) return;
    const result = editFromForm(form, claim.profile);
    if (!result.ok) {
      setFieldError({ field: result.field, message: result.message });
      return;
    }
    setFieldError(null);
    void prepare("edit", result.edit);
  }

  const setField = (field: keyof ClaimForm) => (value: string) => {
    setForm(current => ({ ...current, [field]: value }));
    setFieldError(null);
  };
  const shownFieldError = (field: ClaimField) => (fieldError && fieldError.field === field && fieldError.message !== NO_CHANGE_LINE ? fieldError.message : null);

  const connectedLine = connected && (
    <p className={note}>
      Connected wallet <span className="break-all font-mono text-xs text-ns-ink">{connected.address}</span>
    </p>
  );

  const connectControls = (label: string) => (
    <>
      {choices ? (
        <div className="flex flex-wrap gap-3" role="group" aria-label="Choose a wallet">
          {choices.map(wallet => (
            <button key={wallet.id} type="button" className={pill} disabled={busy} onClick={() => void connectTo(wallet)}>
              {wallet.name}
            </button>
          ))}
        </div>
      ) : (
        <button type="button" className={pill} disabled={busy} onClick={() => void connect()}>
          {label}
        </button>
      )}
    </>
  );

  const preview = prepared && (
    <div className="space-y-3">
      <p className={note}>{prepared.action === "claim" ? PREVIEW_CLAIM_LINE : PREVIEW_EDIT_LINE}</p>
      <pre className="whitespace-pre-wrap break-words rounded-xl border border-[var(--ns-glass-border)] bg-black/30 p-4 font-mono text-xs leading-5 text-ns-ink">{prepared.message}</pre>
      <p className={note}>
        {NOTICE.before}
        <a href="/terms" target="_blank" rel="noopener noreferrer" className={textLink}>{NOTICE.terms}</a>
        {NOTICE.middle}
        <a href="/privacy" target="_blank" rel="noopener noreferrer" className={textLink}>{NOTICE.privacy}</a>
        {NOTICE.after}
      </p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <button ref={signButton} type="button" className={pill} disabled={busy} onClick={() => void sign()}>
          Sign in your wallet
        </button>
        <button type="button" className={quiet} disabled={busy} onClick={() => setPrepared(null)}>
          Cancel
        </button>
      </div>
    </div>
  );

  const walletSwitch = connected && (
    <button type="button" className={quiet} disabled={busy} onClick={disconnect}>
      Use a different wallet
    </button>
  );

  return (
    <section aria-labelledby="dossier-claim" className={card}>
      <h3 id="dossier-claim" className="text-lg font-medium tracking-[-.02em] text-[#F2FFF5]">{CLAIM_HEADING}</h3>
      <div className="mt-4 space-y-5">
        {view === "open" && (
          <>
            <p className={note}>{claimIntro(chainLabel)}</p>
            <p className={note}>{NO_COST_LINE}</p>
            <p className={note}>{CLAIM_MEANS_LINE}</p>
            {connectedLine}
            {!prepared && (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                {connected ? (
                  <>
                    <button type="button" className={pill} disabled={busy} onClick={() => void prepare("claim")}>
                      Claim this agent
                    </button>
                    {walletSwitch}
                  </>
                ) : (
                  connectControls("Connect a wallet")
                )}
              </div>
            )}
            {preview}
          </>
        )}

        {(view === "claimed" || view === "yours" || view === "held") && claim && (
          <>
            <p className={note}>{view === "held" ? HELD_LINE : claimedLine(claim.wallet)}</p>
            {view !== "held" && <p className={note}>{lastCheckedLine(formatWhen(claim.lastOwnerCheckAt))}</p>}
          </>
        )}

        {view === "claimed" && claim && (
          <>
            <OwnerText profile={claim.profile} />
            {connected && <p className={note}>{NOT_HOLDER_LINE}</p>}
            {connectedLine}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {connected ? walletSwitch : connectControls("Hold this claim? Connect your wallet")}
            </div>
          </>
        )}

        {view === "yours" && claim && (
          <>
            {connectedLine}
            <p className={note}>You hold this claim. What you write here is yours to change, one signed edit at a time.</p>
            <form onSubmit={review} className="space-y-4" noValidate>
              <fieldset disabled={busy || prepared !== null} className="space-y-4">
                <legend className="sr-only">What you say about this agent</legend>
                <div>
                  <label htmlFor="claim-name" className="eyebrow">Name</label>
                  <input id="claim-name" className={input} value={form.name} onChange={event => setField("name")(event.target.value)} autoComplete="off" aria-describedby="claim-name-hint" aria-invalid={shownFieldError("name") !== null} />
                  <p id="claim-name-hint" className="mt-1 text-xs text-ns-ink-dim">{shownFieldError("name") ?? FIELD_HINTS.name}</p>
                </div>
                <div>
                  <label htmlFor="claim-website" className="eyebrow">Website</label>
                  <input id="claim-website" className={input} value={form.website} onChange={event => setField("website")(event.target.value)} inputMode="url" autoComplete="off" aria-describedby="claim-website-hint" aria-invalid={shownFieldError("website") !== null} />
                  <p id="claim-website-hint" className="mt-1 text-xs text-ns-ink-dim">{shownFieldError("website") ?? FIELD_HINTS.website}</p>
                </div>
                <div>
                  <label htmlFor="claim-description" className="eyebrow">Description</label>
                  <textarea id="claim-description" className={input} rows={4} value={form.description} onChange={event => setField("description")(event.target.value)} aria-describedby="claim-description-hint" aria-invalid={shownFieldError("description") !== null} />
                  <p id="claim-description-hint" className="mt-1 text-xs text-ns-ink-dim">{shownFieldError("description") ?? FIELD_HINTS.description}</p>
                </div>
                <div>
                  <label htmlFor="claim-links" className="eyebrow">Links</label>
                  <textarea id="claim-links" className={input} rows={3} value={form.links} onChange={event => setField("links")(event.target.value)} aria-describedby="claim-links-hint" aria-invalid={shownFieldError("links") !== null} />
                  <p id="claim-links-hint" className="mt-1 text-xs text-ns-ink-dim">{shownFieldError("links") ?? FIELD_HINTS.links}</p>
                </div>
              </fieldset>
              {!prepared && (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                  <button type="submit" className={pill} disabled={busy}>
                    Review the change
                  </button>
                  {walletSwitch}
                  {fieldError?.message === NO_CHANGE_LINE && <p className="text-sm text-ns-ink-dim">{NO_CHANGE_LINE}</p>}
                </div>
              )}
            </form>
            {preview}
          </>
        )}

        <ClaimHistory entryId={entryId} />
      </div>
      {/* The status stays in the page so a screen reader hears it change; with nothing to say it takes no room. */}
      <div role="status" aria-live="polite" className="text-sm text-ns-ink-dim [&:not(:empty)]:mt-5">{STEP_LABEL[step] || notice || ""}</div>
      {error && <p role="alert" className="mt-5 max-w-2xl text-sm leading-6 text-[#FFB4A8]">{error}</p>}
    </section>
  );
}
