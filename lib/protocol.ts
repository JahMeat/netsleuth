/**
 * Wire protocol shared by the Next.js client and the PartyKit room server.
 *
 * Everything that crosses the WebSocket is described here so the client and
 * server can never drift.
 *
 * Three rules carry the game, all enforced in `party/main.ts`:
 *
 *  1. `RoomSnapshot` is broadcast, so nothing secret may live on it. Roles and
 *     task lists are delivered per-connection instead.
 *  2. The Hacker is never *sent* the packet feed, so there is nothing to reveal
 *     by tampering with their own client.
 *  3. Task progress is credited by the server from validated actions. A client
 *     cannot claim work it did not do, and the Hacker's work never counts.
 */

import type { AnomalyKind, AttackKind, Packet } from "./packets";
import type { Task, TaskKind } from "./tasks";

export type { AnomalyKind, AttackKind, Packet, Task, TaskKind };

export type Phase = "lobby" | "playing" | "meeting" | "ended";

export type Role = "benign" | "hacker";

export type OutReason = "voted" | "compromised";

/**
 * A player as *everyone* sees them. This object is broadcast, so it carries no
 * role — and, since the redesign, no address either.
 *
 * Hiding the address is what makes the game work from both sides. The hacker
 * has to hunt for a victim's IP instead of reading it off a list, and the
 * analysts have to argue their way from "something hostile came from .24" to
 * "who here is .24?". You learn your own address and nobody else's.
 */
export interface Player {
  id: string;
  name: string;
  isHost: boolean;
  out: boolean;
  outReason: OutReason | null;
  /** Whether they still hold their one meeting call. */
  canCallMeeting: boolean;
}

/** Shared task progress. Work belonging to players who are out leaves the total. */
export interface Progress {
  done: number;
  total: number;
}

export interface Evidence {
  seq: number;
  packet: Packet;
  byId: string;
  byName: string;
  hit: boolean;
  /** What it really was: an attack, a scan, or a compromise. */
  kind: AnomalyKind | null;
}

export interface Vote {
  voterId: string;
  targetId: string | null;
}

export type EndReason =
  | "tasks_complete"
  | "hacker_ejected"
  | "time_expired"
  | "analysts_outnumbered"
  | "hacker_left";

export interface RoundResult {
  hackerId: string;
  hackerName: string;
  benignWin: boolean;
  reason: EndReason;
  progress: Progress;
  hits: {
    playerId: string;
    name: string;
    hits: number;
    misses: number;
    tasksDone: number;
  }[];
  attacksLaunched: number;
}

/** The shared, non-secret view of a room. Safe to send to every connection. */
export interface RoomSnapshot {
  code: string;
  phase: Phase;
  players: Player[];
  deadline: number | null;
  progress: Progress;
  /** Gateway address. Not secret: it is the one host everybody talks to. */
  gatewayIp: string;
  /** Set while an attack is stalling task work. */
  stalledUntil: number | null;
  /** Meeting only. */
  meetingCalledBy: string | null;
  evidence: Evidence[];
  votes: Vote[];
  /** Ended only. */
  result: RoundResult | null;
}

/** Client -> server. */
export type ClientMessage =
  | { type: "hello"; intent: "create" | "join"; name: string }
  | { type: "kick"; playerId: string }
  | { type: "transferHost"; playerId: string }
  | { type: "startGame" }
  /** One unit of work on one of your own tasks. The server decides if it counts. */
  | { type: "work"; taskId: string }
  /** Hacker only. */
  | { type: "attack"; kind: AttackKind }
  /** Hacker only: sweep for a named player's address. Loud, and slow to return. */
  | { type: "scan"; playerId: string }
  /** Hacker only: take out a player whose address you have already found. */
  | { type: "compromise"; ip: string }
  /** Analysts only: mark a packet as suspicious. */
  | { type: "flag"; seq: number }
  /** Burn your one meeting call. */
  | { type: "callMeeting" }
  | { type: "vote"; targetId: string | null };

export type ErrorCode =
  | "room_not_found"
  | "name_taken"
  | "bad_message"
  | "not_host"
  | "unknown_player"
  | "kicked"
  | "not_enough_players"
  | "already_started"
  | "not_hacker"
  | "on_cooldown"
  | "wrong_phase"
  | "no_meeting_left"
  | "stalled"
  | "out"
  | "unknown_ip"
  | "scanning";

/** Server -> client. */
export type ServerMessage =
  | { type: "snapshot"; room: RoomSnapshot; youId: string }
  /** Your private role. Sent to one connection only, never on the snapshot. */
  | { type: "role"; role: Role }
  /**
   * Your own task list. The Hacker receives one that looks identical and
   * advances normally on their screen — it simply never moves the shared bar.
   */
  | { type: "tasks"; tasks: Task[] }
  /** Analysts only: new traffic. The Hacker never receives this. */
  | { type: "packets"; packets: Packet[] }
  /** Your own address. Sent to one connection only — nobody learns anyone else's. */
  | { type: "whoami"; ip: string }
  /** Hacker only: the result of a scan, once it finishes. */
  | { type: "scanResult"; playerId: string; name: string; ip: string }
  /** You were compromised. Terminal, like being voted out. */
  | { type: "compromised" }
  | { type: "takeover"; untilMs: number }
  | { type: "flagAck"; seq: number; hit: boolean }
  | { type: "kicked"; byName: string }
  | { type: "error"; code: ErrorCode; message: string };

export const MAX_NAME_LENGTH = 16;

/** Social deduction needs a crowd to hide in. */
export const MIN_PLAYERS = 3;

/** Tasks per player. */
export const TASKS_PER_PLAYER = 4;

/** Hard ceiling on the round. Expiry with work outstanding is a Hacker win. */
export const ROUND_MS = 300_000;
/** How long an address sweep takes to come back. Long enough to be caught. */
export const SCAN_MS = 6_000;
/** Gap between compromises, so the hacker cannot clear the room at once. */
export const COMPROMISE_COOLDOWN_MS = 35_000;
/** Gap between scans. */
export const SCAN_COOLDOWN_MS = 20_000;
/** Discussion + voting window once someone calls a meeting. */
export const MEETING_MS = 75_000;
export const TAKEOVER_MS = 6_000;
/** How long a disruption freezes everyone's task work. */
export const STALL_MS = 8_000;
export const ATTACK_COOLDOWN_MS = 25_000;
export const GLOBAL_ATTACK_COOLDOWN_MS = 10_000;
export const FEED_WINDOW = 240;

export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);
  return name.length > 0 ? name : null;
}

export const ATTACK_LABELS: Record<
  AttackKind,
  { name: string; blurb: string; effect: string }
> = {
  spoof: {
    name: "Spoofing",
    blurb: "Poison ARP so the gateway answers from your MAC.",
    effect: "Loud in the feed, but touches nobody's work.",
  },
  disrupt: {
    name: "Disruption",
    blurb: "Flood a host with half-open connections.",
    effect: "Freezes everyone's tasks for 8 seconds.",
  },
  takeover: {
    name: "Takeover",
    blurb: "Hijack a live session and drive it.",
    effect: "Seizes one analyst's screen for 6 seconds.",
  },
};

export const TASK_VERBS: Record<TaskKind, string> = {
  type: "Type it out",
  click: "Clear each alert",
  wind: "Wind it up",
};
