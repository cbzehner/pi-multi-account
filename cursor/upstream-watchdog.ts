/**
 * The counterpart to the SSE keepalive.
 *
 * Keepalives make sure a healthy-but-quiet turn is never cut off by a timer on the client side.
 * That also means nothing on the client side can end a turn Cursor has silently abandoned — and
 * Cursor does abandon turns: the h2 stream stays up, heartbeats are acknowledged, and no
 * interaction update ever arrives again. Left alone such a turn sits on "Working…" forever.
 *
 * So progress is judged where it can actually be observed: on frames coming back from Cursor.
 * Every server message, including thinking deltas, blob traffic, and checkpoints, pushes the
 * deadline back. Only a stream that has produced *nothing* for the whole window is declared
 * stalled, and the proxy then ends the turn with an explicit error so Pi and failover can react.
 */

/** Five minutes of complete upstream silence. Real thinks stream `thinkingDelta` well within this. */
export const UPSTREAM_STALL_TIMEOUT_MS = 5 * 60_000;

/** `PI_CURSOR_UPSTREAM_STALL_MS` overrides the window; `0` disables the watchdog. */
export function resolveUpstreamStallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PI_CURSOR_UPSTREAM_STALL_MS?.trim();
  if (raw === undefined || raw === "") return UPSTREAM_STALL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return UPSTREAM_STALL_TIMEOUT_MS;
  return Math.floor(parsed);
}

export function formatStallDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

export interface UpstreamWatchdog {
  /** Record upstream progress; the stall deadline moves forward. */
  touch(): void;
  /** Retire the watchdog. Idempotent; later touches are ignored. */
  stop(): void;
}

/**
 * Arm a stall watchdog. `onStall` runs at most once, with how long upstream had been silent.
 * A non-positive `timeoutMs` produces an inert watchdog.
 */
export function startUpstreamWatchdog(onStall: (silentForMs: number) => void, timeoutMs: number): UpstreamWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = timeoutMs <= 0;
  let lastProgressAt = Date.now();

  const arm = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopped) return;
      stopped = true;
      timer = undefined;
      onStall(Date.now() - lastProgressAt);
    }, timeoutMs);
    timer.unref?.();
  };

  arm();

  return {
    touch() {
      if (stopped) return;
      lastProgressAt = Date.now();
      arm();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
