import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPPORT_EMAIL } from "../lib/contacts";
import ErrorBoundary from "./ErrorBoundary";

/**
 * What a visitor sees when the page fails to draw. The error's message and stack name modules, functions and sometimes addresses of
 * the client, so they go to the browser's console and never onto the page.
 */
afterEach(() => vi.restoreAllMocks());

const secret = new Error("Cannot read properties of undefined (reading 'secretField') at https://internal.example/api/v1/private?token=abc123");
secret.stack = `Error: ${secret.message}\n    at renderAgentCard (https://nooscape.si/assets/index-AbC123.js:2:99182)\n    at Home (https://nooscape.si/assets/index-AbC123.js:2:101)`;

function failedPage(): string {
  const boundary = new ErrorBoundary({ children: null });
  // React hands the thrown error to getDerivedStateFromError; the screen must not show it whatever the state holds.
  boundary.state = (ErrorBoundary.getDerivedStateFromError as unknown as (error: Error) => ErrorBoundary["state"])(secret);
  return renderToStaticMarkup(boundary.render() as ReactElement);
}

describe("the error screen", () => {
  it("says something went wrong and how to write to us, and nothing of the error", () => {
    const html = failedPage();
    expect(html).toContain("An unexpected error occurred.");
    expect(html).toContain(SUPPORT_EMAIL);
    expect(html).toContain("Reload Page");
    for (const leaked of ["secretField", "internal.example", "token=abc123", "renderAgentCard", "index-AbC123", "Cannot read properties", "<pre", "at Home"]) expect(html, leaked).not.toContain(leaked);
  });

  it("draws its children while nothing has failed", () => {
    const boundary = new ErrorBoundary({ children: "all is well" });
    expect(boundary.state.hasError).toBe(false);
    expect(boundary.render()).toBe("all is well");
  });

  it("keeps the error for the browser's console, where only the visitor's own developer tools show it", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    new ErrorBoundary({ children: null }).componentDidCatch(secret);
    expect(log).toHaveBeenCalledWith("[ErrorBoundary]", secret);
  });

  it("is held to it in the source: the error is never read onto the page", () => {
    const source = readFileSync(fileURLToPath(new URL("./ErrorBoundary.tsx", import.meta.url)), "utf8");
    expect(source).not.toMatch(/\.stack|\.message|error\?\./);
    expect(source).not.toMatch(/<pre/);
  });
});
