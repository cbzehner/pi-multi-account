import type { ServerResponse } from "node:http";

/**
 * Cursor can stay silent for minutes between accepting a request and emitting the first token.
 * `res.writeHead()` alone puts nothing on the wire — Node and Pi's Bun runtime both hold the
 * head until the first body write — so during that silence the client has received no bytes,
 * its fetch has not resolved, and every timeout in its stack is still armed. Pi gave up around
 * five minutes with "Request timed out." and failover re-sent the prompt.
 *
 * So: flush the head now, and write an SSE comment on a cadence until the caller stops it.
 * Comments (`: ...`) are dropped by every SSE consumer, including the OpenAI SDK.
 */
export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

/** Open a streaming SSE response and keep it warm. Returns the function that stops the keepalive. */
export function startSSEResponse(res: ServerResponse, keepaliveIntervalMs = SSE_KEEPALIVE_INTERVAL_MS): () => void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.flushHeaders();

  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    res.write(": keepalive\n\n");
  }, keepaliveIntervalMs);

  return () => clearInterval(timer);
}
