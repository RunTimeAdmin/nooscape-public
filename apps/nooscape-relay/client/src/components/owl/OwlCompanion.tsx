import { useRef, useState } from "react";
import { usePointerKind } from "@/hooks/usePointerKind";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { OWL_SIZE } from "./owlRig";
import { OwlBubble } from "./OwlBubble";
import { OwlSvg } from "./OwlSvg";
import { useOwlRig, type Rest } from "./useOwlRig";

/** The owl that follows the pointer. Decoration only: it takes no pointer events and is hidden from assistive technology. Its note about a record is a separate element beside it (OwlBubble), read out by a live region of its own. */
export default function OwlCompanion() {
  const boxRef = useRef<HTMLDivElement>(null);
  const coarse = usePointerKind() === "coarse";
  const reducedMotion = useReducedMotion();
  const [rest, setRest] = useState<Rest | null>(null);
  useOwlRig({ boxRef, reducedMotion, coarse, onRest: setRest });
  const size = coarse ? OWL_SIZE.coarse : OWL_SIZE.fine;
  // Off screen until the first frame places it.
  return (
    <>
      <div ref={boxRef} className="owl-companion" aria-hidden="true" style={{ width: size.width, height: size.height, transform: "translate3d(-300px,-300px,0)" }}>
        <OwlSvg />
      </div>
      <OwlBubble rest={rest} coarse={coarse} />
    </>
  );
}
