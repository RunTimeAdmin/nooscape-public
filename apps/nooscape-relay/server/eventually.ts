/**
 * For database-backed tests. An ingestion write marks the cached directory
 * aggregates stale instead of dropping them: the next read is still answered from
 * the cache, and a background reload replaces the value behind it. A test that
 * wrote through the db module therefore reads until the answer is the expected one
 * (returning the last answer read if the time runs out, so the assertion that
 * follows reports what was actually served).
 */
export async function eventually<T>(read: () => Promise<T>, expected: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (expected(value) || Date.now() > deadline) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
