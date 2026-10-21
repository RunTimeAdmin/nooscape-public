import { FormEvent, useState } from "react";
import { KeyRound, Loader2, Search } from "lucide-react";
import { API_TIER_NAMES, API_TIERS, type ApiTier } from "@shared/apiKey";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";

/**
 * The operator's tool for API keys (docs/data-access-2026-10-19.md, stage D2): list the newest keys or those of one email, set a key's
 * tier by hand (the paid tiers are only ever set here, after the operator and the customer have agreed on terms), and end a key. A key
 * is shown by its first characters and never in full: the server holds only its hash. Shown on the operator page only.
 */
type KeyRow = { id: string; prefix: string; ownerEmail: string; tier: string; createdAt: Date; revokedAt: Date | null; lastUsedAt: Date | null };

const when = (value: Date | null) => (value ? new Date(value).toLocaleString() : "never");

function KeyCard({ row, onChanged }: { row: KeyRow; onChanged: (message: string) => void }) {
  const [tier, setTier] = useState<ApiTier>(API_TIER_NAMES.includes(row.tier as ApiTier) ? (row.tier as ApiTier) : "free");
  const setTierMutation = trpc.apiKeys.setTier.useMutation({ onSuccess: result => onChanged(`${row.prefix}… is now ${result.tier}.`), onError: error => onChanged(error.message) });
  const end = trpc.apiKeys.revokeById.useMutation({ onSuccess: () => onChanged(`${row.prefix}… was ended.`), onError: error => onChanged(error.message) });
  const busy = setTierMutation.isPending || end.isPending;
  const live = row.revokedAt === null;

  const applyTier = () => {
    if (tier === row.tier) return;
    if (!window.confirm(`Set ${row.prefix}… (${row.ownerEmail}) to ${tier}? That is ${API_TIERS[tier].perDay.toLocaleString("en-US")} requests a day. Do this only for terms already agreed.`)) return;
    setTierMutation.mutate({ id: row.id, tier });
  };
  const endKey = () => {
    if (!window.confirm(`End ${row.prefix}… (${row.ownerEmail})? It stops working at once and cannot be turned back on.`)) return;
    end.mutate({ id: row.id });
  };

  return (
    <li className="source-ops-panel" style={{ listStyle: "none", minWidth: 0, overflowWrap: "anywhere" }}>
      <p><strong>{live ? row.tier : `${row.tier}, ended`}</strong> <code>{row.prefix}…</code> {row.ownerEmail}</p>
      <p className="source-ops-review-note">Made {when(row.createdAt)}. Last used {when(row.lastUsedAt)}.{live ? "" : ` Ended ${when(row.revokedAt)}.`} Key id <code>{row.id}</code></p>
      {live ? (
        <div className="source-ops-form">
          <div>
            <Label htmlFor={`tier-${row.id}`}>Tier</Label>
            <select id={`tier-${row.id}`} value={tier} onChange={event => setTier(event.target.value as ApiTier)} disabled={busy} style={{ display: "block", marginTop: "0.45rem", padding: "0.5rem 0.6rem", borderRadius: "0.5rem", border: "1px solid rgba(255,255,255,0.13)", background: "rgba(0,0,0,0.2)", color: "#effff3" }}>
              {API_TIER_NAMES.map(name => (
                <option key={name} value={name}>{API_TIERS[name].label}</option>
              ))}
            </select>
          </div>
          <Button type="button" variant="outline" disabled={busy || tier === row.tier} onClick={applyTier}>
            {setTierMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Set the tier
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={endKey}>
            {end.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} End the key
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function OperatorKeys() {
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const [asked, setAsked] = useState<{ email: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const keys = trpc.apiKeys.list.useQuery({ ...(asked && asked.email ? { email: asked.email } : {}) }, { enabled: asked !== null, retry: false, refetchOnWindowFocus: false });

  const lookUp = (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    setAsked({ email: email.trim() });
  };
  const changed = (message: string) => {
    setNotice(message);
    void utils.apiKeys.list.invalidate();
  };

  return (
    <section className="source-ops-list" aria-label="API keys">
      <div className="source-ops-list-header">
        <div><p className="eyebrow">REST API</p><h2>API keys</h2></div>
        <span>{asked === null ? "List the newest keys" : `${keys.data?.length ?? 0} shown`}</span>
      </div>
      <form onSubmit={lookUp} className="source-ops-form" style={{ padding: "1rem" }}>
        <div>
          <Label htmlFor="keys-email">Email (leave empty for the newest 50)</Label>
          <Input id="keys-email" type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="off" />
        </div>
        <Button type="submit" disabled={keys.isFetching}>
          {keys.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : email.trim() ? <Search className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />} {email.trim() ? "Look up" : "List keys"}
        </Button>
      </form>
      {notice ? <div className="source-ops-notice" role="status">{notice}</div> : null}
      {keys.error ? <div className="source-ops-loading source-ops-error">{keys.error.message}</div> : null}
      {asked !== null && !keys.isLoading && !keys.error && keys.data?.length === 0 ? <div className="source-ops-loading">No key matches.</div> : null}
      {keys.data && keys.data.length > 0 ? (
        <ul style={{ padding: "0 1rem 1rem", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "1rem" }}>
          {keys.data.map(row => <KeyCard key={row.id} row={row} onChanged={changed} />)}
        </ul>
      ) : null}
    </section>
  );
}
