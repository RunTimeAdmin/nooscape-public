import { lazy, Suspense } from "react";
import { useLocation } from "wouter";
import { useOwl } from "@/contexts/OwlContext";
import { owlAllowedOn } from "./owlRoutes";

// Loaded after the first paint, and only where the owl is allowed and switched on.
const OwlCompanion = lazy(() => import("./OwlCompanion"));

export function OwlLayer() {
  const { enabled } = useOwl();
  const [path] = useLocation();
  if (!enabled || !owlAllowedOn(path)) return null;
  return (
    <Suspense fallback={null}>
      <OwlCompanion />
    </Suspense>
  );
}
