import { useEffect, useState, type MouseEvent } from "react";
import { useLocation } from "wouter";
import { ChevronDown, Menu, Search, X } from "lucide-react";
import { OwlToggle } from "@/components/owl/OwlToggle";
import { TermTip } from "@/components/Term";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useOwl } from "@/contexts/OwlContext";
import { anchorId, isScrolled, MORE_ANCHORS, PAGE_LINKS, PRIMARY_LINKS, type StatusLine } from "./headerModel";

type Props = {
  /** Focus field mode dims the page. While it is on, an Exit focus button stays in the bar. */
  focused: boolean;
  onToggleFocus: () => void;
  /** The button in the bar: open the agent search, or scroll to the map while the atlas is still loading. */
  onAskTheOwl: () => void;
  onOpenDeepMap: () => void;
  status: readonly StatusLine[];
};

/** True once the page has scrolled past the header's own height, so it can take a glass background. */
function useScrolled() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(isScrolled(window.scrollY));
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return scrolled;
}

/**
 * Scrolls to a heading on the page. The page's own CSS decides whether that is smooth, so reduced motion is respected.
 * On a page that has no such heading (the full field), the link goes to the home page and its section instead.
 */
function scrollToAnchor(event: MouseEvent<HTMLElement>, href: string, afterwards?: () => void, goHome?: (to: string) => void) {
  const id = anchorId(href);
  if (!id) return;
  event.preventDefault();
  afterwards?.();
  if (!document.getElementById(id) && goHome) {
    goHome(`/${href}`);
    return;
  }
  // A menu or sheet may still be closing and holding the page still, so wait a frame.
  window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
}

const NAV_LINK = "inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium text-ns-ink-dim transition-colors hover:text-ns-ink focus-visible:text-ns-ink";
const ROW = "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-base text-ns-ink transition-colors hover:bg-white/[0.06] focus-visible:bg-white/[0.06]";
const GROUP_LABEL = "px-3 pb-1 pt-4 text-xs font-medium uppercase tracking-[0.14em] text-ns-ink-dim";

function StatusRows({ status }: { status: readonly StatusLine[] }) {
  return (
    <>
      {status.map(line => (
        <div key={line.label} className="flex items-baseline justify-between gap-4 px-3 py-1.5 text-sm">
          <span className="text-ns-ink-dim">{line.label}</span>
          <span className="font-mono text-xs uppercase tracking-[0.1em] text-ns-ink">{line.value}</span>
        </div>
      ))}
    </>
  );
}

/**
 * The Home header: the brand, three page links, one button and a menu, with a sheet in place of the menu on a
 * phone. It sticks to the top and takes a glass background after 24px of scrolling.
 */
export function SiteHeader({ focused, onToggleFocus, onAskTheOwl, onOpenDeepMap, status }: Props) {
  const scrolled = useScrolled();
  const { enabled: owlOn, setEnabled: setOwlOn } = useOwl();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [, navigate] = useLocation();
  const closeSheet = () => setSheetOpen(false);

  return (
    <header
      data-owl-avoid="fixed"
      data-scrolled={scrolled ? "" : undefined}
      className="site-header sticky top-0 z-30 transition-[background-color,box-shadow] duration-300 ease-ns data-[scrolled]:bg-[color-mix(in_oklab,var(--ns-void)_72%,transparent)] data-[scrolled]:shadow-[0_1px_0_var(--ns-glass-border)] data-[scrolled]:backdrop-blur-xl"
    >
      <div className="site-header-inner mx-auto flex max-w-[1540px] items-center gap-3 px-4 py-2 sm:px-5 lg:px-8">
        <a href="#top" className="group mr-auto flex min-h-11 min-w-11 items-center gap-3 lg:mr-0">
          <span className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full border border-[#BFFF76]/50 bg-[#BFFF76]/[0.08] transition group-hover:scale-110">
            <img src="/favicon.svg" alt="" width="32" height="32" className="h-8 w-8 rounded-xl" />
          </span>
          <span className="max-[429px]:sr-only">
            <span className="block text-sm font-semibold uppercase tracking-[0.29em] text-ns-ink">Nooscape</span>
            <span className="mt-0.5 hidden font-mono text-xs uppercase tracking-[0.18em] text-ns-ink-dim sm:block">Open agent observatory</span>
          </span>
        </a>

        <nav aria-label="Primary" className="ml-auto hidden items-center gap-1 lg:flex">
          {PRIMARY_LINKS.map(link => (
            <a key={link.href} href={link.href} onClick={event => scrollToAnchor(event, link.href, undefined, navigate)} className={NAV_LINK}>
              {link.label}
            </a>
          ))}
        </nav>

        <div className="header-actions flex items-center gap-2 lg:ml-3">
          {focused && (
            <Button
              data-focus-toggle
              onClick={onToggleFocus}
              aria-pressed={focused}
              className="h-11 rounded-full bg-ns-radar/15 px-4 text-sm font-medium text-ns-ink shadow-[inset_0_0_0_1px_var(--ns-radar)] hover:bg-ns-radar/25"
            >
              <X size={16} />
              Exit focus
            </Button>
          )}
          <TermTip k="askTheOwl">
            <Button onClick={onAskTheOwl} className="h-11 rounded-full bg-ns-radar px-4 text-sm font-semibold text-ns-void shadow-ns-glow hover:bg-ns-radar hover:brightness-110 sm:px-5">
              <Search size={16} />
              Ask the Owl
            </Button>
          </TermTip>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="hidden h-11 gap-1.5 rounded-full px-4 text-sm font-medium text-ns-ink-dim hover:bg-white/[0.06] hover:text-ns-ink data-[state=open]:text-ns-ink lg:inline-flex">
                More
                <ChevronDown size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={8} className="w-80 border-0 bg-ns-dusk p-2 text-ns-ink shadow-[inset_0_0_0_1px_var(--ns-glass-border),0_24px_60px_rgba(0,0,0,0.55)]">
              <DropdownMenuGroup>
                <DropdownMenuLabel className={GROUP_LABEL}>On this page</DropdownMenuLabel>
                {MORE_ANCHORS.map(link => (
                  <DropdownMenuItem key={link.href} asChild className="min-h-11 cursor-pointer rounded-lg px-3 text-sm">
                    <a href={link.href} onClick={event => scrollToAnchor(event, link.href, undefined, navigate)}>{link.label}</a>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem onSelect={onOpenDeepMap} className="min-h-11 cursor-pointer rounded-lg px-3 text-sm">Deep map</DropdownMenuItem>
                {!focused && <DropdownMenuItem onSelect={onToggleFocus} className="min-h-11 cursor-pointer rounded-lg px-3 text-sm">Focus field</DropdownMenuItem>}
              </DropdownMenuGroup>
              <DropdownMenuSeparator className="bg-white/10" />
              <DropdownMenuGroup>
                <DropdownMenuLabel className={GROUP_LABEL}>Pages</DropdownMenuLabel>
                {PAGE_LINKS.map(link => (
                  <DropdownMenuItem key={link.href} asChild className="min-h-11 cursor-pointer rounded-lg px-3 text-sm">
                    <a href={link.href}>{link.label}</a>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator className="bg-white/10" />
              <DropdownMenuGroup>
                <DropdownMenuLabel className={GROUP_LABEL}>Settings</DropdownMenuLabel>
                <DropdownMenuCheckboxItem checked={owlOn} onCheckedChange={setOwlOn} className="min-h-11 cursor-pointer rounded-lg px-3 pl-8 text-sm">
                  Owl guide
                </DropdownMenuCheckboxItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator className="bg-white/10" />
              <DropdownMenuGroup>
                <DropdownMenuLabel className={GROUP_LABEL}>Status</DropdownMenuLabel>
                <StatusRows status={status} />
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" aria-label="Open menu" className="h-11 w-11 rounded-full p-0 text-ns-ink hover:bg-white/[0.06] lg:hidden">
                <Menu size={22} />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[min(22rem,92vw)] gap-0 overflow-y-auto border-0 bg-ns-dusk p-0 text-ns-ink shadow-[inset_1px_0_0_var(--ns-glass-border)]">
              <SheetHeader className="p-5 pb-2">
                <SheetTitle className="text-lg font-semibold text-ns-ink">Menu</SheetTitle>
                <SheetDescription className="sr-only">Sections of this page, other pages, and settings.</SheetDescription>
              </SheetHeader>
              <nav aria-label="Menu" className="px-3 pb-8">
                <p className={GROUP_LABEL}>On this page</p>
                {[...PRIMARY_LINKS, ...MORE_ANCHORS].map(link => (
                  <a key={link.href} href={link.href} onClick={event => scrollToAnchor(event, link.href, closeSheet, navigate)} className={ROW}>
                    {link.label}
                  </a>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    closeSheet();
                    onOpenDeepMap();
                  }}
                  className={ROW}
                >
                  Deep map
                </button>
                {!focused && (
                  <button
                    type="button"
                    onClick={() => {
                      closeSheet();
                      onToggleFocus();
                    }}
                    className={ROW}
                  >
                    Focus field
                  </button>
                )}
                <p className={GROUP_LABEL}>Pages</p>
                {PAGE_LINKS.map(link => (
                  <a key={link.href} href={link.href} className={ROW}>
                    {link.label}
                  </a>
                ))}
                <p className={GROUP_LABEL}>Settings</p>
                <OwlToggle />
                <p className={GROUP_LABEL}>Status</p>
                <StatusRows status={status} />
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
