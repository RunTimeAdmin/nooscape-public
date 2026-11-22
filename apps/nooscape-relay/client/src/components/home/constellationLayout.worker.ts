import { answerLayout, type LayoutRequest } from "./constellationLayout";

/** The map's layout, off the page's thread (constellationLayout.ts). */
self.addEventListener("message", (event: MessageEvent<LayoutRequest>) => self.postMessage(answerLayout(event.data)));
