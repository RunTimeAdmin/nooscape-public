/** The Owl as a line drawing, for the margins of a section. Decoration only: it holds no words and is hidden from assistive technology. */
export function OwlLineArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 140" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className}>
      <path d="M28 58C28 34 44 22 60 22C76 22 92 34 92 58C98 80 94 118 60 128C26 118 22 80 28 58Z" />
      <path d="M34 30L28 12L46 24M86 30L92 12L74 24" />
      <circle cx="46" cy="52" r="10" />
      <circle cx="74" cy="52" r="10" />
      <circle cx="46" cy="52" r="3" />
      <circle cx="74" cy="52" r="3" />
      <path d="M54 62L60 72L66 62Z" />
      <path d="M30 78C22 96 30 112 44 116M90 78C98 96 90 112 76 116" />
      <path d="M48 92L60 100L72 92M48 104L60 112L72 104" />
      <path d="M24 134H96" />
    </svg>
  );
}
