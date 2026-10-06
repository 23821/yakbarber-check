// Temporary folders and containers must be removed even when a run is interrupted (Ctrl-C) —
// they can hold customer code. Anything that creates one registers its cleanup here.
type Task = () => unknown;
const tasks = new Set<Task>();

/** Registers a cleanup to run if the process is interrupted. Returns a function that unregisters it. */
export function onInterrupt(task: Task): () => void {
  tasks.add(task);
  return () => tasks.delete(task);
}

export async function runInterruptCleanups(): Promise<void> {
  const pending = [...tasks];
  tasks.clear();
  await Promise.allSettled(pending.map(async (task) => task()));
}

let installed = false;

/** For command-line entry points: on Ctrl-C or termination, clean up, then exit. */
export function cleanUpOnInterrupt(log: (message: string) => void = (m) => console.error(m)): void {
  if (installed) return;
  installed = true;
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.once(signal, async () => {
      log("\nStopping — removing temporary copies…");
      await Promise.race([runInterruptCleanups(), new Promise((resolve) => setTimeout(resolve, 15_000))]);
      process.exit(code);
    });
  }
}
