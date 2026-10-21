import { ChainTabs } from "@/components/home/ChainTabs";
import { FieldNotes } from "@/components/home/FieldNotes";
import { FleetCards } from "@/components/home/FleetCards";
import { HowItWorks } from "@/components/home/HowItWorks";
import { NoiseFunnel } from "@/components/home/NoiseFunnel";
import { OwlsCatch } from "@/components/home/OwlsCatch";
import type { FleetWallet, FunnelStep } from "@/components/home/noiseModel";

type Status = "loading" | "ready" | "unavailable";

type Props = {
  funnelSteps: readonly FunnelStep[];
  funnelStatus: Status;
  asOfBlock: number | null;
  activity: { secondaryTransfers: number; handoutTransfers: number; uriUpdates: number } | null;
  wallets: readonly FleetWallet[];
  walletStatus: Status;
  bnbProfile: { recorded: number; listed: number } | null;
};

/** The one funnel (Clear the Fog) with the fleet sightings beside it, the regions, the field reports with the Owl's Catch beside them, and how the Owl sees, in that order. The first two are fed from reads Home already makes; the tabs read `liveData.chainStats`, the reports `liveData.directoryActivityFeed` and the catch `liveData.owlsCatch`. */
export default function LandingEvidence({ funnelSteps, funnelStatus, asOfBlock, activity, wallets, walletStatus, bnbProfile }: Props) {
  return (
    <div className="mb-5 space-y-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.1fr_.9fr]">
        <NoiseFunnel steps={funnelSteps} status={funnelStatus} asOfBlock={asOfBlock} activity={activity} />
        <FleetCards wallets={wallets} status={walletStatus} />
      </div>
      <ChainTabs bnbProfile={bnbProfile} />
      <div className="grid grid-cols-1 items-stretch gap-5 lg:grid-cols-[1.1fr_.9fr]">
        <FieldNotes />
        <OwlsCatch />
      </div>
      <HowItWorks />
    </div>
  );
}
