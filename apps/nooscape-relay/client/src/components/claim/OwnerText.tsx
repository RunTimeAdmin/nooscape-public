import type { ClaimProfile } from "@shared/claimProfile";
import { OWNER_LINK_REL, OWNER_TEXT_LABEL, OWNER_TEXT_NOTE, safeHttpsHref } from "@/lib/claimFlow";

/**
 * What the owner of a claimed agent wrote (docs/claims-2026-10-18.md), shown beside what Nooscape observed and never in its place,
 * labelled as the owner's own word. Everything here is text: React escapes it, nothing is HTML, and an address is a link only when
 * it is an https one, with `nofollow ugc noopener noreferrer`. It renders nothing when the owner has written nothing, which is also
 * what a claim on hold and a claim whose text was removed look like.
 */
const note = "max-w-2xl text-sm leading-6 text-ns-ink-dim";
const link =
  "break-all text-ns-ink underline decoration-ns-radar/50 underline-offset-4 transition hover:decoration-ns-radar focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ns-radar";

function OwnerLink({ address }: { address: string }) {
  const href = safeHttpsHref(address);
  if (!href) return <span className="break-all text-ns-ink">{address}</span>;
  return (
    <a href={href} target="_blank" rel={OWNER_LINK_REL} className={link}>
      {address}
    </a>
  );
}

export function OwnerText({ profile }: { profile: ClaimProfile }) {
  if (!profile.name && !profile.website && !profile.description && profile.links.length === 0) return null;
  return (
    <div>
      <p className="eyebrow">{OWNER_TEXT_LABEL}</p>
      <p className={`${note} mt-2`}>{OWNER_TEXT_NOTE}</p>
      <dl className="mt-3 space-y-3 text-sm">
        {profile.name && (
          <div>
            <dt className="eyebrow">Name</dt>
            <dd className="mt-1 break-words text-ns-ink">{profile.name}</dd>
          </div>
        )}
        {profile.website && (
          <div>
            <dt className="eyebrow">Website</dt>
            <dd className="mt-1">
              <OwnerLink address={profile.website} />
            </dd>
          </div>
        )}
        {profile.description && (
          <div>
            <dt className="eyebrow">Description</dt>
            <dd className="mt-1 break-words text-ns-ink">{profile.description}</dd>
          </div>
        )}
        {profile.links.length > 0 && (
          <div>
            <dt className="eyebrow">Links</dt>
            <dd className="mt-1">
              <ul className="space-y-1">
                {profile.links.map(address => (
                  <li key={address}>
                    <OwnerLink address={address} />
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
