/**
 * One request under one deadline: the timer is armed before the request and
 * stays armed through `read`, so a server that sends headers and then stalls
 * (or trickles the body) aborts exactly like a slow header phase instead of
 * parking the run. Each adapter used to carry its own copy of this shape, and
 * the "timer cleared before the body read" bug had to be fixed once per copy.
 *
 * - `redirect: "error"` is fixed: approved sources are exact URLs and never
 *   redirect, so a redirect is a policy violation, not something to follow.
 * - `read` runs under the armed timer. It receives the response after the
 *   request resolves, so it is where status and content-type checks and the
 *   bounded body read belong. Anything it throws that `isDomainError` accepts
 *   passes through untouched.
 * - An abort maps to `onTimeout()`; every other failure maps to `onFailure()`,
 *   so each adapter keeps its own error class and message.
 */
export async function fetchUnderDeadline<TBody>(options: {
  url: string;
  init: Omit<RequestInit, "signal" | "redirect">;
  timeoutMs: number;
  isDomainError: (error: unknown) => boolean;
  onTimeout: () => Error;
  onFailure: () => Error;
  read: (response: Response) => Promise<TBody>;
}): Promise<{ response: Response; body: TBody }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(options.url, { ...options.init, redirect: "error", signal: controller.signal });
    const body = await options.read(response);
    return { response, body };
  } catch (error) {
    if (options.isDomainError(error)) throw error;
    if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw options.onTimeout();
    }
    throw options.onFailure();
  } finally {
    clearTimeout(timer);
  }
}
