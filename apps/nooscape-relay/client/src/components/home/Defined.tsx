import { Term } from "@/components/Term";
import type { GlossaryKey } from "@/lib/glossary";
import { splitLabel } from "./heroModel";

/** A line that starts with a name the glossary defines ("Steady light: ..."), the name carrying its definition and the rest as it is. */
export function Defined({ k, text }: { k: GlossaryKey; text: string }) {
  const { label, rest } = splitLabel(text);
  return label ? (
    <>
      <Term k={k}>{label}</Term>
      {rest}
    </>
  ) : (
    <>{text}</>
  );
}
