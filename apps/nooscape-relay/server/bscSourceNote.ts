/**
 * What a BNB entry's source note says about reading its registration link.
 *
 * The directory pass records chain data. A one-off census on 2026-10-16 (docs/bsc-b1-measurement-2026-10-16.md) did read some
 * registration links and did not record which. Since the BNB registration-file step (docs/approvals/2026-10-17-bnb-registration-files.md)
 * the worker also reads the file behind the https or ipfs link of a listed entry, slowly, to group look-alike entries, and keeps
 * only the grouping key and the host of the first agent address. A note that said Nooscape "did not fetch it" is no longer true,
 * so the note says what happens. The sentence is kept short because the note is stored with it and its column is 512 characters.
 *
 * Notes stored before this wording carry one of two older sentences. currentBnbSourceNote reads each as the current one when an
 * entry is served, so no stored row is rewritten.
 */
export const BNB_FETCH_SENTENCE =
  "The directory pass reads chain data and, for a listed entry's https or ipfs link, the file behind it, to group look-alike entries; it keeps only a grouping key and a host. A one-off census on 2026-10-16 had read some links earlier.";

const BNB_NOTE_PREFIX = "BNB Smart Chain ERC-8004 registration.";
/** The sentence of notes stored before 2026-10-17. */
const OLD_FETCH_SENTENCE = "; Nooscape did not fetch it.";
/** The sentence of notes stored on 2026-10-17, before the registration-file step. */
const PREVIOUS_FETCH_SENTENCE =
  "The directory pass records chain data only and did not fetch it. A one-off census on 2026-10-16 fetched some registration links that were on the chain that day; which ones is not recorded.";

export function currentBnbSourceNote(note: string | null): string | null {
  if (!note || !note.startsWith(BNB_NOTE_PREFIX)) return note;
  if (note.includes(PREVIOUS_FETCH_SENTENCE)) return note.replace(PREVIOUS_FETCH_SENTENCE, BNB_FETCH_SENTENCE);
  if (note.includes(OLD_FETCH_SENTENCE)) return note.replace(OLD_FETCH_SENTENCE, `. ${BNB_FETCH_SENTENCE}`);
  return note;
}
