import { Link } from "wouter";
import {
  ArrowLeft,
  ArrowUpRight,
  BadgeCheck,
  CircleCheck,
  CircleX,
  Database,
  Eye,
  Fingerprint,
  Globe2,
  Network,
  Orbit,
  Radar,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { trpc } from "@/lib/trpc";

const isItems = [
  {
    icon: Radar,
    title: "An open agent observatory",
    detail: "A public surface for locating agent records and reading the evidence boundary around each observation.",
  },
  {
    icon: Database,
    title: "A source-scoped public index",
    detail: "Every projected record remains tied to its approved source and strong identity—not a name or similarity match.",
  },
  {
    icon: Fingerprint,
    title: "A verifier for signed evidence",
    detail: "Public packets are checked against the active, pinned Nooscape relay key—not merely any valid signature.",
  },
  {
    icon: Eye,
    title: "A transparent source ledger",
    detail: "The public source status view distinguishes approval, activity, pause, and revocation from trust tiers.",
  },
] as const;

const isNotItems = [
  "An agent runtime, workflow orchestrator, or hosted execution environment.",
  "An agent payment, compute, token, or settlement network.",
  "A token or a coin. Nooscape has issued no token on any chain and is not connected to any token that uses its name. Nothing on this site is an offer to sell a token or a place to buy one.",
  "A wallet, custodian, exchange, payment processor, or transaction initiator.",
  "A safety certification, a universal reputation score, or proof that every source claim is true.",
  "An unbounded crawler: Nooscape does not crawl the open web or invoke discovered tools. It reads approved sources and asks the addresses their records name, such as the endpoints reviewed agents declare (once a day at most), within limits on time and size.",
] as const;

const flow = [
  { number: "01", title: "Approve", detail: "A source boundary is reviewed before any observation is allowed." },
  { number: "02", title: "Retain", detail: "Approved metadata is preserved with a content digest and immutable retention." },
  { number: "03", title: "Project", detail: "A reviewed observation becomes a source-scoped public record—never a silent global merge." },
  { number: "04", title: "Verify", detail: "A signed public envelope makes the provenance boundary inspectable." },
] as const;

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.1] bg-black/20 p-4 shadow-[inset_0_1px_rgba(255,255,255,.025)]">
      <p className="font-mono text-[9px] uppercase tracking-[.16em] text-[#7f9186]">{label}</p>
      <strong className="mt-2 block font-mono text-2xl tracking-[-.06em] text-[#f0fff2]">{value}</strong>
      <span className="mt-1 block text-[11px] leading-4 text-[#8fa096]">{note}</span>
    </div>
  );
}

export default function WhatNooscapeIs() {
  const coverage = trpc.liveData.publicCoverage.useQuery(undefined, {
    refetchOnWindowFocus: true,
    staleTime: 20_000,
  });
  const count = coverage.data?.publicRecordCount;
  const ready = coverage.data?.provenanceReadyCount;
  const percentage = coverage.data?.coveragePercent;

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#06070b] text-[#eaf7ee]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_55%_48%_at_15%_-10%,rgba(191,255,118,.12),transparent_67%),radial-gradient(ellipse_40%_34%_at_90%_14%,rgba(195,166,255,.13),transparent_70%),radial-gradient(ellipse_46%_40%_at_45%_100%,rgba(102,232,255,.07),transparent_75%)]" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(191,255,118,.055)_1px,transparent_1px),linear-gradient(90deg,rgba(191,255,118,.055)_1px,transparent_1px)] [background-size:42px_42px] [mask-image:linear-gradient(to_bottom,black,transparent_72%)]" />

      <header className="relative z-10 mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-5 py-5 lg:px-8">
        <Link href="/" className="group flex items-center gap-3" aria-label="Return to Nooscape Atlas">
          <span className="relative grid h-10 w-10 place-items-center rounded-full border border-[#bfff76]/50 bg-[#bfff76]/[.08] transition duration-200 group-hover:scale-105"><img src="/favicon.svg" alt="" width="32" height="32" className="h-8 w-8 rounded-xl" /><span className="absolute inset-[-5px] rounded-full border border-[#bfff76]/20" /></span>
          <span><strong className="block text-sm font-semibold uppercase tracking-[.29em] text-[#f1fff3]">Nooscape</strong><em className="mt-0.5 block font-mono text-[9px] not-italic uppercase tracking-[.18em] text-[#718378]">Positioning brief</em></span>
        </Link>
        <nav className="flex items-center gap-2" aria-label="Nooscape navigation">
          <Link href="/sources" className="inline-flex h-9 items-center gap-2 rounded-full border border-white/[.12] bg-white/[.025] px-3 font-mono text-[10px] uppercase tracking-[.12em] text-[#c6d8cb] transition hover:border-[#bfff76]/40 hover:text-[#eaffdf]"><Network size={14} /><span className="hidden sm:inline">Sources</span></Link>
          <Link href="/verify" className="inline-flex h-9 items-center gap-2 rounded-full border border-[#bfff76]/30 bg-[#bfff76]/[.07] px-3 font-mono text-[10px] uppercase tracking-[.12em] text-[#d8ffc5] transition hover:bg-[#bfff76] hover:text-[#071006]"><ShieldCheck size={14} /><span className="hidden sm:inline">Verify</span></Link>
          <Link href="/" className="inline-flex h-9 items-center gap-2 rounded-full border border-[#c3a6ff]/30 bg-[#c3a6ff]/[.07] px-3 font-mono text-[10px] uppercase tracking-[.12em] text-[#e2d8ff] transition hover:bg-[#c3a6ff] hover:text-[#160f24]"><ArrowLeft size={14} /><span className="hidden sm:inline">Atlas</span></Link>
        </nav>
      </header>

      <div className="relative z-10 mx-auto max-w-[1440px] px-5 pb-16 pt-10 lg:px-8 lg:pb-24 lg:pt-16">
        <section className="grid gap-12 lg:grid-cols-[minmax(0,1.08fr)_minmax(360px,.72fr)] lg:items-end">
          <div>
            <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.2em] text-[#bfff76]"><span className="h-1.5 w-1.5 rounded-full bg-[#bfff76] shadow-[0_0_12px_#bfff76]" /> Public positioning / evidence boundary</p>
            <h1 className="mt-5 max-w-4xl text-[clamp(3.6rem,8vw,8.4rem)] font-semibold leading-[.79] tracking-[-.078em] text-[#f2fff5]">Discovery,<br /><span className="bg-[linear-gradient(100deg,#bfff76_5%,#d7cbff_52%,#65ecff_88%)] bg-clip-text text-transparent">without pretending</span><br />to be the network.</h1>
            <p className="mt-8 max-w-2xl text-base leading-7 text-[#a9b8ae] lg:text-lg">Nooscape is an open agent observatory, and the evidence layer for agent trust. It watches registries it does not run, keeps the evidence it can read, and labels each record by how much has been checked. It does not execute agents, route value, or turn what a source claims into trust.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/" className="inline-flex items-center gap-2 rounded-full border border-[#bfff76]/35 bg-[#bfff76]/[.09] px-4 py-3 font-mono text-[10px] font-bold uppercase tracking-[.14em] text-[#d7ffc4] transition hover:bg-[#bfff76] hover:text-[#071006]">Explore the Atlas <ArrowUpRight size={14} /></Link>
              <Link href="/verify" className="inline-flex items-center gap-2 rounded-full border border-white/[.12] bg-white/[.025] px-4 py-3 font-mono text-[10px] font-bold uppercase tracking-[.14em] text-[#cddcd0] transition hover:border-[#66e8ff]/40 hover:text-[#e8ffff]">Verify a packet <Fingerprint size={14} /></Link>
            </div>
          </div>

          <aside className="relative overflow-hidden rounded-3xl border border-[#bfff76]/25 bg-[#09100e]/80 p-5 shadow-[0_26px_80px_rgba(0,0,0,.32)] backdrop-blur-xl sm:p-6">
            <div aria-hidden="true" className="absolute right-[-42px] top-[-52px] h-40 w-40 rounded-full border border-[#bfff76]/30" />
            <div aria-hidden="true" className="absolute right-[-6px] top-[-17px] h-24 w-24 rounded-full border border-[#c3a6ff]/35" />
            <div className="relative"><p className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[.18em] text-[#bfff76]"><BadgeCheck size={13} /> Current public boundary</p><h2 className="mt-3 max-w-sm text-2xl font-medium leading-tight tracking-[-.045em] text-[#effff2]">The map is a record of what Nooscape can show—not a claim to know every agent.</h2></div>
            <div className="relative mt-6 grid grid-cols-3 gap-2.5">
              <Metric label="Public records" value={count === undefined ? "…" : String(count)} note="source-scoped" />
              <Metric label="Evidence ready" value={ready === undefined ? "…" : String(ready)} note="signed envelopes" />
              <Metric label="Coverage" value={percentage === undefined ? "…" : `${percentage}%`} note="retained provenance" />
            </div>
            <p className="relative mt-5 border-t border-white/[.09] pt-4 text-xs leading-5 text-[#91a399]">Counts describe the current reviewed projection. They do not measure the total agent ecosystem, safety, quality, or market share.</p>
          </aside>
        </section>

        <section className="mt-20 grid gap-4 lg:grid-cols-2" aria-label="What Nooscape is and is not">
          <article className="rounded-3xl border border-[#bfff76]/22 bg-[#bfff76]/[.045] p-6 sm:p-8">
            <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl border border-[#bfff76]/35 bg-[#bfff76]/[.1] text-[#cfffad]"><CircleCheck size={20} /></span><div><p className="font-mono text-[9px] uppercase tracking-[.17em] text-[#bfff76]">What Nooscape is</p><h2 className="mt-1 text-2xl tracking-[-.045em] text-[#f0fff2]">A transparent discovery surface.</h2></div></div>
            <div className="mt-7 grid gap-3">{isItems.map(({ icon: Icon, title, detail }) => <article key={title} className="group flex gap-4 rounded-2xl border border-white/[.075] bg-black/[.13] p-4 transition hover:border-[#bfff76]/30 hover:bg-[#bfff76]/[.045]"><span className="mt-0.5 text-[#bfff76]"><Icon size={17} /></span><div><h3 className="text-sm font-medium text-[#e5f8e9]">{title}</h3><p className="mt-1 text-xs leading-5 text-[#95a69b]">{detail}</p></div></article>)}</div>
          </article>

          <article className="rounded-3xl border border-[#ff9fe7]/18 bg-[#ff9fe7]/[.035] p-6 sm:p-8">
            <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl border border-[#ff9fe7]/28 bg-[#ff9fe7]/[.08] text-[#ffd2f0]"><CircleX size={20} /></span><div><p className="font-mono text-[9px] uppercase tracking-[.17em] text-[#ffb5e7]">What Nooscape is not</p><h2 className="mt-1 text-2xl tracking-[-.045em] text-[#fdf0fa]">A system that acts for you.</h2></div></div>
            <ul className="mt-7 grid gap-3">{isNotItems.map(item => <li key={item} className="flex gap-3 rounded-2xl border border-white/[.075] bg-black/[.13] p-4 text-sm leading-5 text-[#c3b5bf]"><ShieldAlert className="mt-0.5 shrink-0 text-[#ff9fe7]" size={16} /><span>{item}</span></li>)}</ul>
            <div className="mt-6 rounded-2xl border border-[#c3a6ff]/22 bg-[#c3a6ff]/[.055] p-4"><p className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[.15em] text-[#d8caff]"><Orbit size={13} /> Naming and platform boundary</p><p className="mt-2 text-xs leading-5 text-[#bcb0ce]">Nooscape is independent from Noos Network. Nooscape is a discovery and evidence Atlas; Noos describes an economic and settlement layer for agent skills. Nooscape does not route agent calls, settle rewards, or issue a token.</p></div>
          </article>
        </section>

        <section className="mt-20" aria-labelledby="record-flow-title">
          <div className="max-w-2xl"><p className="font-mono text-[10px] uppercase tracking-[.18em] text-[#66e8ff]">How a public record becomes visible</p><h2 id="record-flow-title" className="mt-3 text-4xl font-medium tracking-[-.06em] text-[#effff3] sm:text-5xl">The record is not the claim.</h2><p className="mt-4 text-base leading-7 text-[#9aaca1]">Nooscape exposes the path from a bounded public observation to a public record. A signature protects the envelope from alteration; it does not automatically prove every claim inside the underlying source.</p></div>
          <div className="mt-9 grid gap-3 md:grid-cols-4">{flow.map(({ number, title, detail }, index) => <article key={title} className="relative min-h-48 rounded-2xl border border-white/[.1] bg-white/[.025] p-5"><span className="font-mono text-[11px] tracking-[.14em] text-[#bfff76]">{number}</span>{index < flow.length - 1 && <span aria-hidden="true" className="absolute right-[-11px] top-1/2 z-10 hidden h-px w-5 bg-[#bfff76]/35 md:block" />}<h3 className="mt-9 text-xl tracking-[-.035em] text-[#e6f7e9]">{title}</h3><p className="mt-3 text-xs leading-5 text-[#8fa095]">{detail}</p></article>)}</div>
        </section>

        <section className="mt-20 rounded-3xl border border-[#66e8ff]/20 bg-[linear-gradient(125deg,rgba(102,232,255,.08),rgba(195,166,255,.06)_48%,rgba(191,255,118,.07))] p-6 sm:p-8 lg:flex lg:items-end lg:justify-between lg:gap-10">
          <div className="max-w-3xl"><p className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[.18em] text-[#82efff]"><Sparkles size={13} /> A better question than “is this agent trusted?”</p><h2 className="mt-3 text-3xl font-medium tracking-[-.055em] text-[#f0ffff] sm:text-4xl">What was observed, by whom, when, and what does it actually prove?</h2><p className="mt-4 text-sm leading-6 text-[#b1c4c8]">That is the question Nooscape is built to keep public. Explore the Atlas to compare live records, inspect source status, or verify a downloaded evidence packet.</p></div>
          <div className="mt-6 flex shrink-0 flex-wrap gap-3 lg:mt-0"><Link href="/sources" className="inline-flex items-center gap-2 rounded-full border border-[#66e8ff]/30 bg-[#66e8ff]/[.08] px-4 py-3 font-mono text-[10px] font-bold uppercase tracking-[.13em] text-[#c8fbff] transition hover:bg-[#66e8ff] hover:text-[#061012]">View sources <Globe2 size={14} /></Link><Link href="/" className="inline-flex items-center gap-2 rounded-full border border-white/[.13] bg-black/[.16] px-4 py-3 font-mono text-[10px] font-bold uppercase tracking-[.13em] text-[#e5f3e8] transition hover:border-[#bfff76]/40 hover:text-[#dfffcb]">Return to Atlas <ArrowUpRight size={14} /></Link></div>
        </section>
      </div>
    </main>
  );
}
