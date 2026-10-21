/**
 * Where people write to Nooscape, and what the site promises about the reply. The pages that name an address or a reply
 * time read it from here, and client/src/pages/legalPages.test.ts holds every use to these values.
 */
export const TRUST_EMAIL = "trust@nooscape.si";
export const SUPPORT_EMAIL = "support@nooscape.si";
export const SECURITY_EMAIL = "security@nooscape.si";

/**
 * The reply time promised for a dispute or a privacy question. One person answers that mailbox, so the promise is a
 * business day and not a clock: a promise that a weekend can break would make a trust site's page untrue.
 */
export const REPLY_WITHIN = "one business day";
