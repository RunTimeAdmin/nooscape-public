import type { ReactElement, ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { glossary, type GlossaryKey } from "@/lib/glossary";

function Definition({ k }: { k: GlossaryKey }) {
  const entry = glossary[k];
  return (
    <TooltipContent side="top" className="max-w-[280px] rounded-xl border border-[#BFFF76]/25 bg-[#0A0E11] px-3.5 py-2.5 shadow-[0_18px_44px_rgba(0,0,0,.45)]">
      <p className="font-mono text-xs uppercase tracking-[.15em] text-[#BFFF76]">{entry.title}</p>
      <p className="mt-1 text-xs leading-4 text-[#DFFFF0]">{entry.sentence}</p>
    </TooltipContent>
  );
}

// A glossary term: dotted underline, keyboard focusable, plain-sentence
// definition one hover or tap away. Falls back to plain text when the key has
// no entry, so copy can ship before its definition does.
export function Term({ k, children }: { k: GlossaryKey; children: ReactNode }) {
  if (!glossary[k]) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="term-hint" tabIndex={0}>{children}</span>
      </TooltipTrigger>
      <Definition k={k} />
    </Tooltip>
  );
}

// The same definition on a button or a link, which can be focused already, so it adds no stop of its own.
export function TermTip({ k, children }: { k: GlossaryKey; children: ReactElement }) {
  if (!glossary[k]) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <Definition k={k} />
    </Tooltip>
  );
}
