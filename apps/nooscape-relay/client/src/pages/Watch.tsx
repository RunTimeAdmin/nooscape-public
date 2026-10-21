import { ScaffoldPage } from "@/components/ScaffoldPage";
import { Term } from "@/components/Term";

/** Your Watch: the agents you follow. A scaffold behind the "watch" switch, so it only says what it is for. */
export default function Watch() {
  return (
    <ScaffoldPage
      eyebrow={<Term k="yourWatch">Your Watch</Term>}
      title="Your Watch"
      lead="Keep an eye on the agents you care about. The Owl tells you when their record changes."
      notice="Your Watch is not open yet. Nothing on this page saves or sends anything."
    />
  );
}
