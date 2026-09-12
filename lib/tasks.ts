/**
 * Tasks are the engine of the whole game now.
 *
 * Doing one emits packets from your own IP, so the feed stops being abstract
 * traffic and becomes a record of who has been busy. That is what makes an idle
 * player suspicious, and what gives the Hacker something to stall.
 *
 * Pure and dependency-free so it can be exercised from plain Node.
 */

export type TaskKind = "type" | "click" | "wind";

export interface Task {
  id: string;
  kind: TaskKind;
  label: string;
  /** Typing phrase, or "" for the other kinds. */
  phrase: string;
  /** Work units needed to finish. */
  steps: number;
  /** Work units done so far. */
  done: number;
}

const PHRASES = [
  "audit the egress rules",
  "rotate the service token",
  "patch the edge gateway",
  "drain the stale sessions",
  "verify the cert chain",
  "reindex the flow logs",
  "quarantine the subnet",
  "reconcile the arp cache",
  "purge the resolver cache",
  "seal the admin console",
];

const LABELS: Record<TaskKind, string[]> = {
  type: ["File incident note", "Draft change request", "Annotate the ticket"],
  click: ["Acknowledge alerts", "Clear the queue", "Approve the rollout"],
  wind: ["Spin up the tunnel", "Charge the relay", "Prime the collector"],
};

function pick<T>(rand: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rand() * xs.length)];
}

/** How many packets one unit of work on this kind of task produces. */
export const PACKETS_PER_STEP: Record<TaskKind, number> = {
  type: 1,
  click: 1,
  wind: 2,
};

/**
 * A player's task list. Everyone gets the same shape of work so the traffic
 * they produce is comparable — a Hacker faking tasks must look identical.
 */
export function createTaskList(rand: () => number = Math.random, count = 4): Task[] {
  const kinds: TaskKind[] = ["type", "click", "wind"];
  const out: Task[] = [];

  for (let i = 0; i < count; i++) {
    const kind = kinds[i % kinds.length];
    // Steps are the unit of work *and* the unit of traffic, so each kind needs
    // enough of them to leave a readable trail rather than a single blip.
    const phrase = kind === "type" ? pick(rand, PHRASES) : "";
    const steps =
      kind === "type" ? phrase.split(" ").length : kind === "click" ? 6 : 10;
    out.push({
      id: `t${i}`,
      kind,
      label: pick(rand, LABELS[kind]),
      phrase,
      steps,
      done: 0,
    });
  }

  // Shuffle so the kinds are not in a predictable order on screen.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function isComplete(t: Task): boolean {
  return t.done >= t.steps;
}

export function totalSteps(tasks: Task[]): number {
  return tasks.reduce((n, t) => n + t.steps, 0);
}

export function doneSteps(tasks: Task[]): number {
  return tasks.reduce((n, t) => n + Math.min(t.done, t.steps), 0);
}
