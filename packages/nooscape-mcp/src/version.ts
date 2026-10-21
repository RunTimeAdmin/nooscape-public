import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** The package's own version: sent as the user agent and reported to MCP clients. */
export const VERSION: string = (require("../package.json") as { version: string }).version;
