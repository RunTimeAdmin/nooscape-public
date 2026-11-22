import { trpc } from "@/lib/trpc";
import { endOperatorView, isOperatorRead, isUnauthorized } from "@/lib/operatorSession";
import { QUERY_DEFAULTS } from "@/lib/queryDefaults";
import { apiLinks } from "@/lib/trpcLinks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
// The two typefaces the site uses, served from this site (docs/self-hosted-fonts-2026-10-18.md). Each file declares its subsets
// with a unicode-range, so a page downloads only the ones its text needs.
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/dm-mono/400.css";
import "@fontsource/dm-mono/500.css";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({ defaultOptions: QUERY_DEFAULTS });

// A read or an action refused as unauthorized means the operator's session ended (signed out in another tab, or expired): drop what it
// read and show the sign-in (lib/operatorSession.ts).
queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    console.error("[API Query Error]", event.query.state.error);
    if (isUnauthorized(event.query.state.error) && isOperatorRead(event.query.queryKey)) endOperatorView(queryClient);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    console.error("[API Mutation Error]", event.mutation.state.error);
    if (isUnauthorized(event.mutation.state.error)) endOperatorView(queryClient);
  }
});

const trpcClient = trpc.createClient({ links: apiLinks() });

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
