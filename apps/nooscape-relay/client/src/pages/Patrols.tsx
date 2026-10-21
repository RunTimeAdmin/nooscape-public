import { ScaffoldPage } from "@/components/ScaffoldPage";
import { Term } from "@/components/Term";

/** Patrols: reports of fleets the Owl missed. A scaffold behind the "patrols" switch, so it only says what it is for. */
export default function Patrols() {
  return (
    <ScaffoldPage
      eyebrow={<Term k="patrols">Patrols</Term>}
      title="Patrols"
      lead="Spot a fleet the Owl missed? File a patrol report. Confirmed reports go into Field Reports."
      notice="Patrols are not open yet, so there is nothing to file. When they open, each report is reviewed before anything is published."
    />
  );
}
