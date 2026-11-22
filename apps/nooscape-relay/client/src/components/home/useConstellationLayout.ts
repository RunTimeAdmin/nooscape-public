import { useEffect, useMemo, useState } from "react";
import { layoutInput, type LayoutReply, type LayoutRequest } from "./constellationLayout";
import { layoutNodes, type ConstellationNode, type ConstellationRecord } from "./constellationModel";

let worker: Worker | null | undefined;
let busy = false;
let nextId = 0;

function startWorker(): Worker | null {
  try {
    return typeof Worker === "function" ? new Worker(new URL("./constellationLayout.worker.ts", import.meta.url), { type: "module" }) : null;
  } catch {
    return null;
  }
}

/**
 * One worker for the page. A request that comes while it is still busy with an older one stops it and starts a fresh one, so a
 * resize never queues seconds of stale work. If the worker cannot run (it failed to load), the layout is done here instead,
 * and every later request too.
 */
export function requestLayout(records: readonly ConstellationRecord[], aspect: number, done: (nodes: ConstellationNode[]) => void): () => void {
  if (worker === undefined) worker = startWorker();
  if (worker !== null && busy) {
    worker.terminate();
    worker = startWorker();
  }
  if (worker === null) {
    done(layoutNodes(records, aspect));
    return () => {};
  }
  const current = worker;
  const id = (nextId += 1);
  const onMessage = (event: MessageEvent<LayoutReply>) => {
    if (event.data.id !== id) return;
    busy = false;
    done(event.data.nodes);
  };
  const onError = () => {
    busy = false;
    if (worker === current) worker = null;
    done(layoutNodes(records, aspect));
  };
  current.addEventListener("message", onMessage);
  current.addEventListener("error", onError);
  busy = true;
  current.postMessage({ id, records: layoutInput(records), aspect } satisfies LayoutRequest);
  return () => {
    current.removeEventListener("message", onMessage);
    current.removeEventListener("error", onError);
  };
}

/**
 * The nodes the map shows, and whether they are placed. Until the worker answers, the nodes are the same ones in the same
 * order at the spots their ids hash to (`place: false`, a few milliseconds), so the list and the keyboard work; the canvas
 * waits for the placed ones. A later answer replaces an earlier one, and the earlier one stays on screen until it comes.
 * The worker is asked only once the canvas has measured its shape. Where there is no worker, the layout runs here, as before.
 */
export function useConstellationLayout(records: readonly ConstellationRecord[], signature: string, aspect: number, measured: boolean): { nodes: ConstellationNode[]; placed: boolean } {
  const hasWorker = typeof Worker === "function";
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` stands for `records`
  const unplaced = useMemo(() => layoutNodes(records, aspect, { place: false }), [signature, aspect]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` stands for `records`
  const here = useMemo(() => (hasWorker ? null : layoutNodes(records, aspect)), [hasWorker, signature, aspect]);
  const [placed, setPlaced] = useState<ConstellationNode[] | null>(null);

  useEffect(() => {
    if (!hasWorker || !measured) return;
    return requestLayout(records, aspect, setPlaced);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` stands for `records`
  }, [hasWorker, measured, signature, aspect]);

  if (here) return { nodes: here, placed: true };
  return placed ? { nodes: placed, placed: true } : { nodes: unplaced, placed: false };
}
