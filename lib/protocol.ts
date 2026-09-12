/**
 * Wire protocol shared by the Next.js client and the PartyKit room server.
 *
 * Everything that crosses the WebSocket is described here so the client and
 * server can never drift.
 *
 * The load-bearing rule: `RoomSnapshot` is broadcast to everyone, so nothing
 * secret may live on it. Roles and the packet feed are delivered per-connection
 * instead, gated by role on the server.
 */

import type { AttackKind, Packet } from "./packets";

export type { AttackKind, Packet };

export type Phase = "lobby" | "playing" | "meeting" | "ended";

export type Role = "benign" | "hacker";

/**
 * A player as *everyone* sees them. There is deliberately no `role` here: this
 * object is broadcast, and a role on it would hand the Hacker away in devtools.
 */
export interface Player {
  id: string;
  name: string;
  isHost: boolean;
}

/** A packet someone marked as suspicious. */
export interface Evidence {
  seq: number;
  packet: Packet;
  byId: string;
  byName: string;
  /** Whether it really was part of an attack. Only revealed in the meeting. */
  hit: boolean;
  kind: AttackKind | null;
}

export interface Vote {
  voterId: string;
  /** null means an explicit skip. */
  targetId: string | null;
}

export interface RoundResult {
  hackerId: string;
  hackerName: string;
  /** Who the room voted out, or null on a skip/tie. */
  ejectedId: string | null;
  ejectedName: string | null;
  benignWin: boolean;
  /** Flags that landed on real attack traffic, per player. */
  hits: { playerId: string; name: string; hits: number; misses: number }[];
  attacksLaunched: number;
}

/** The shared, non-secret view of a room. Safe to send to every connection. */
export interface RoomSnapshot {
  code: string;
  phase: Phase;
  players: Player[];
  /** Epoch ms when the current phase ends, or null if it has no clock. */
  deadline: number | null;
  /** Meeting only. */
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
  /** Host only: a tick of generated traffic. The server decides who sees it. */
  | { type: "feed"; packets: RawFeedPacket[] }
  /** Hacker only: launch an attack. */
  | { type: "attack"; kind: AttackKind }
  /** Benign only: mark a packet as suspicious. */
  | { type: "flag"; seq: number }
  /** Meeting only: vote to eject, or skip with null. */
  | { type: "vote"; targetId: string | null };

/** Packets as the host sends them up, ground truth attached. */
export interface RawFeedPacket extends Packet {
  anomaly: AttackKind | null;
}

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
  | "wrong_phase";

/** Server -> client. */
export type ServerMessage =
  | { type: "snapshot"; room: RoomSnapshot; youId: string }
  /**
   * Your private role. Sent to one connection only, never on the snapshot.
   * `hackerTargets` is the Hacker's view of who they are hiding among.
   */
  | { type: "role"; role: Role }
  /** Benign only: new traffic. The Hacker never receives this. */
  | { type: "packets"; packets: Packet[] }
  /**
   * Host only: the server is asking the host's generator to splice in an
   * attack. It deliberately does not say who asked for it.
   */
  | { type: "inject"; kind: AttackKind; victimLabel?: string }
  /** Sent to the victim of a takeover: show the attacker-controlled screen. */
  | { type: "takeover"; untilMs: number }
  /** Feedback on your own flag, so flagging feels responsive. */
  | { type: "flagAck"; seq: number; hit: boolean }
  | { type: "kicked"; byName: string }
  | { type: "error"; code: ErrorCode; message: string };

export const MAX_NAME_LENGTH = 16;

/**
 * Social deduction needs a crowd to hide in. With two players the Hacker is
 * whoever is not you, so the game does not exist below three.
 */
export const MIN_PLAYERS = 3;

/** Round length before the meeting is called, in ms. */
export const ROUND_MS = 180_000;
/** Discussion + voting window, in ms. */
export const MEETING_MS = 75_000;
/** How long a takeover holds the victim's screen, in ms. */
export const TAKEOVER_MS = 6_000;
/** Per-attack cooldown so the Hacker cannot simply spam the feed, in ms. */
export const ATTACK_COOLDOWN_MS = 25_000;
/** Shortest gap between any two attacks, in ms. */
export const GLOBAL_ATTACK_COOLDOWN_MS = 10_000;
/** How many packets a monitor keeps on screen. */
export const FEED_WINDOW = 240;

/** Trim/clamp a display name. Returns null if nothing usable is left. */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);
  return name.length > 0 ? name : null;
}

export const ATTACK_LABELS: Record<AttackKind, { name: string; blurb: string }> = {
  spoof: {
    name: "Spoofing",
    blurb: "Poison ARP so the gateway address answers from your MAC.",
  },
  disrupt: {
    name: "Disruption",
    blurb: "Flood a host with half-open connections until it buckles.",
  },
  takeover: {
    name: "Takeover",
    blurb: "Hijack a live session and drive it for a few seconds.",
  },
};
