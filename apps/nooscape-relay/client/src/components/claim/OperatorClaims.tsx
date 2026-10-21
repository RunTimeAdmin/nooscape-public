import { FormEvent, useState } from "react";
import { Loader2, Search, ShieldAlert } from "lucide-react";
import { CLAIM_FIELDS, type ClaimField } from "@shared/claimProfile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { entryIdFrom } from "@/lib/claimFlow";
import { trpc } from "@/lib/trpc";

/**
 * The operator's tool for claims (docs/claims-2026-10-18.md): look an entry up by its id or the address of its page, see the claims
 * ever made for it, put one on hold or take it off, and remove what an owner wrote from view. A removal clears the claim's current
 * text and adds a "removed" row to the history, so the public history says that a change was made and not what it said, and the full
 * record stays. The operator does it when an owner asks at the trust address, or under the Terms. Shown on the operator page only.
 */
const FIELD_NAME: Record<ClaimField, string> = { name: "Name", website: "Website", description: "Description", links: "Links" };

function ClaimCard({ claim, onChanged }: { claim: { id: string; status: string; wallet: string; claimedAt: Date; profile: { name: string | null; website: string | null; description: string | null; links: string[] } }; onChanged: (message: string) => void }) {
  const [fields, setFields] = useState<ClaimField[]>([...CLAIM_FIELDS]);
  const [by, setBy] = useState<"owner" | "nooscape" | null>(null);
  const hold = trpc.claim.freeze.useMutation({ onSuccess: () => onChanged("The claim is on hold."), onError: error => onChanged(error.message) });
  const release = trpc.claim.unfreeze.useMutation({ onSuccess: () => onChanged("The claim is off hold."), onError: error => onChanged(error.message) });
  const remove = trpc.claim.removeText.useMutation({ onSuccess: result => onChanged(`Removed from view: ${result.removed.join(", ")}.`), onError: error => onChanged(error.message) });
  const busy = hold.isPending || release.isPending || remove.isPending;
  const text = [claim.profile.name, claim.profile.website, claim.profile.description, ...claim.profile.links].filter(Boolean);

  const removeChecked = () => {
    if (fields.length === 0 || by === null) return;
    const asked = by === "owner" ? "at the owner's request" : "by Nooscape";
    if (!window.confirm(`Remove the ${fields.join(", ")} text from view ${asked}? The public history will say that, and never why. The full record stays.`)) return;
    remove.mutate({ claimId: claim.id, fields, by });
  };

  return (
    <li className="source-ops-panel" style={{ listStyle: "none", minWidth: 0, overflowWrap: "anywhere" }}>
      <p><strong>{claim.status}</strong> <code>{claim.wallet}</code></p>
      <p className="source-ops-review-note">Claimed {new Date(claim.claimedAt).toLocaleString()}. Claim id <code>{claim.id}</code></p>
      <div style={{ margin: "0.75rem 0" }}>
        {text.length === 0 ? <p>No text is shown for this claim.</p> : <ul>{text.map(line => <li key={line} style={{ overflowWrap: "anywhere" }}>{line}</li>)}</ul>}
      </div>
      <div className="source-ops-form">
        {claim.status === "active" && (
          <Button type="button" variant="outline" disabled={busy} onClick={() => hold.mutate({ claimId: claim.id })}>
            {hold.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />} Put on hold
          </Button>
        )}
        {claim.status === "frozen" && (
          <Button type="button" variant="outline" disabled={busy} onClick={() => release.mutate({ claimId: claim.id })}>
            {release.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Take off hold
          </Button>
        )}
        <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="eyebrow">Remove from view</legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem 1.25rem", margin: "0.5rem 0" }}>
            {CLAIM_FIELDS.map(field => (
              <label key={field} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                <input
                  type="checkbox"
                  checked={fields.includes(field)}
                  onChange={event => setFields(current => (event.target.checked ? [...current, field] : current.filter(item => item !== field)))}
                />
                {FIELD_NAME[field]}
              </label>
            ))}
          </div>
          <div role="radiogroup" aria-label="Who asked for the removal" style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem 1.25rem", margin: "0.5rem 0" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
              <input type="radio" name={`removal-by-${claim.id}`} checked={by === "owner"} onChange={() => setBy("owner")} />
              At the owner&rsquo;s request
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
              <input type="radio" name={`removal-by-${claim.id}`} checked={by === "nooscape"} onChange={() => setBy("nooscape")} />
              By Nooscape, under the Terms
            </label>
          </div>
          <Button type="button" variant="outline" disabled={busy || fields.length === 0 || by === null} onClick={removeChecked}>
            {remove.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Remove the checked text
          </Button>
        </fieldset>
      </div>
    </li>
  );
}

export function OperatorClaims() {
  const utils = trpc.useUtils();
  const [entry, setEntry] = useState("");
  const [lookedUp, setLookedUp] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const claims = trpc.claim.operatorClaims.useQuery({ entryId: lookedUp ?? "" }, { enabled: lookedUp !== null, retry: false, refetchOnWindowFocus: false });

  const lookUp = (event: FormEvent) => {
    event.preventDefault();
    const id = entryIdFrom(entry);
    if (id.length === 0) return;
    setNotice(null);
    setLookedUp(id);
  };
  const changed = (message: string) => {
    setNotice(message);
    void utils.claim.operatorClaims.invalidate();
    void utils.claim.state.invalidate();
    void utils.claim.history.invalidate();
  };

  return (
    <section className="source-ops-list" aria-label="Claims">
      <div className="source-ops-list-header">
        <div><p className="eyebrow">Claim this agent</p><h2>Claims</h2></div>
        <span>{lookedUp === null ? "Look an entry up" : `${claims.data?.length ?? 0} found`}</span>
      </div>
      <form onSubmit={lookUp} className="source-ops-form" style={{ padding: "1rem" }}>
        <div>
          <Label htmlFor="claims-entry">Entry id, or the address of its page</Label>
          <Input id="claims-entry" value={entry} onChange={event => setEntry(event.target.value)} placeholder="https://nooscape.si/agents/..." autoComplete="off" />
        </div>
        <Button type="submit" disabled={entry.trim().length === 0 || claims.isFetching}>
          {claims.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Look up
        </Button>
      </form>
      {notice ? <div className="source-ops-notice" role="status">{notice}</div> : null}
      {claims.error ? <div className="source-ops-loading source-ops-error">{claims.error.message}</div> : null}
      {lookedUp !== null && !claims.isLoading && !claims.error && claims.data?.length === 0 ? <div className="source-ops-loading">No claim has been made for this entry.</div> : null}
      {claims.data && claims.data.length > 0 ? (
        <ul style={{ padding: "0 1rem 1rem", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "1rem" }}>
          {claims.data.map(claim => <ClaimCard key={claim.id} claim={claim} onChanged={changed} />)}
        </ul>
      ) : null}
    </section>
  );
}
