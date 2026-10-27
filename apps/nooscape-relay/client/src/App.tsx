import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { featureOn } from "@shared/features";
import { lazy, Suspense } from "react";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { PageShell } from "./components/PageShell";
import { OwlLayer } from "./components/owl/OwlLayer";
import { OwlProvider } from "./contexts/OwlContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";

// Keep the animated Atlas shell in the initial bundle. Secondary information and
// operator pages load on demand so an expanding documentation surface does not
// slow the public map's first render.
const DeveloperApi = lazy(() => import("./pages/DeveloperApi"));
const DeveloperKeys = lazy(() => import("./pages/DeveloperKeys"));
const EcosystemContext = lazy(() => import("./pages/EcosystemContext"));
const SourceOperations = lazy(() => import("./pages/SourceOperations"));
const SourceStatus = lazy(() => import("./pages/SourceStatus"));
const VerifyEvidence = lazy(() => import("./pages/VerifyEvidence"));
const WhatChanged = lazy(() => import("./pages/WhatChanged"));
const WhatNooscapeIs = lazy(() => import("./pages/WhatNooscapeIs"));
const DirectoryAgent = lazy(() => import("./pages/DirectoryAgent"));
const Catch = lazy(() => import("./pages/Catch"));
const Checker = lazy(() => import("./pages/Checker"));
const ChainExplorer = lazy(() => import("./pages/ChainExplorer"));
const BnbRegistryReport = lazy(() => import("./pages/BnbRegistryReport"));
const BnbRatingsReport = lazy(() => import("./pages/BnbRatingsReport"));
const SolanaRegistryReport = lazy(() => import("./pages/SolanaRegistryReport"));
const RobinhoodRegistryReport = lazy(() => import("./pages/RobinhoodRegistryReport"));
const ArcRegistryReport = lazy(() => import("./pages/ArcRegistryReport"));
const BaseRegistryReport = lazy(() => import("./pages/BaseRegistryReport"));
const Disputes = lazy(() => import("./pages/Disputes"));
const Privacy = lazy(() => import("./pages/Privacy"));
const Terms = lazy(() => import("./pages/Terms"));
const Contact = lazy(() => import("./pages/Contact"));
const Watch = lazy(() => import("./pages/Watch"));
const Patrols = lazy(() => import("./pages/Patrols"));

// Scaffolds, and Arc's page, stay off until VITE_FEATURES names them when the client is built (shared/features.ts). The server reads
// the same list to answer 404 for their addresses until then (server/clientRoutes.ts).
const FEATURES: string | undefined = import.meta.env.VITE_FEATURES;

function Router() {
  return (
    <Suspense fallback={<PageShell />}>
      <Switch>
        <Route path="/">{() => <Home key="home" />}</Route>
        <Route path="/field">{() => <Home key="field" view="field" />}</Route>
        <Route path="/chains/robinhood">{() => <ChainExplorer key="robinhood" chain="robinhood" />}</Route>
        <Route path="/chains/solana">{() => <ChainExplorer key="solana" chain="solana" />}</Route>
        <Route path="/chains/bnb">{() => <ChainExplorer key="bnb" chain="bnb" />}</Route>
        {featureOn("chain_arc", FEATURES) && <Route path="/chains/arc">{() => <ChainExplorer key="arc" chain="arc" />}</Route>}
        {featureOn("chain_base", FEATURES) && <Route path="/chains/base">{() => <ChainExplorer key="base" chain="base" />}</Route>}
        {featureOn("chain_ethereum", FEATURES) && <Route path="/chains/ethereum">{() => <ChainExplorer key="ethereum" chain="ethereum" />}</Route>}
        <Route path="/field/bnb-registry-2026-10-16" component={BnbRegistryReport} />
        <Route path="/field/bnb-ratings-2026-10-16" component={BnbRatingsReport} />
        <Route path="/field/solana-registries-2026-10-18" component={SolanaRegistryReport} />
        <Route path="/field/robinhood-registry-2026-10-20" component={RobinhoodRegistryReport} />
        {featureOn("chain_arc", FEATURES) && <Route path="/field/arc-registry-2026-10-20" component={ArcRegistryReport} />}
        {featureOn("chain_base", FEATURES) && <Route path="/field/base-registry-2026-10-21" component={BaseRegistryReport} />}
        <Route path="/developers" component={DeveloperApi} />
        <Route path="/developers/keys" component={DeveloperKeys} />
        <Route path="/verify" component={VerifyEvidence} />
        <Route path="/sources" component={SourceStatus} />
        <Route path="/context" component={EcosystemContext} />
        <Route path="/about" component={WhatNooscapeIs} />
        <Route path="/changes" component={WhatChanged} />
        <Route path="/checker" component={Checker} />
        <Route path="/disputes" component={Disputes} />
        <Route path="/privacy" component={Privacy} />
        <Route path="/terms" component={Terms} />
        <Route path="/contact" component={Contact} />
        <Route path="/agents/:id" component={DirectoryAgent} />
        <Route path="/catch">{() => <Catch />}</Route>
        <Route path="/catch/:date">{params => <Catch date={params.date} />}</Route>
        {featureOn("watch", FEATURES) && <Route path="/watch" component={Watch} />}
        {featureOn("patrols", FEATURES) && <Route path="/patrols" component={Patrols} />}
        <Route path="/admin/sources" component={SourceOperations} />
        <Route path="/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <OwlProvider>
            <Router />
            <OwlLayer />
          </OwlProvider>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
