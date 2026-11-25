export interface Clock {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
  now(): number;
}

export const systemClock: Clock = {
  sleep,
  random: () => Math.random(),
  now: () => Date.now(),
};

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export function backoffMs(failures: number, random: number): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, failures - 1));
  return Math.round(base * (0.5 + random * 0.5));
}
