/**
 * Wire protocol shared by the Next.js client and the PartyKit room server.
 *
 * Everything that crosses the WebSocket is described here so the client and
 * server can never drift. Later milestones add packet/attack/vote messages to
 * these same unions.
 */

/** Lobby is milestone 2; the rest are placeholders for later milestones. */
export type Phase = "lobby" | "playing" | "meeting" | "ended";

/**
 * A player as the *server* knows them. Note there is deliberately no `role`
 * field here: roles are private, and this object is broadcast to everyone.
 * Role delivery happens over a separate per-connection message (milestone 3).
 */
export interface Player {
  id: string;
  name: string;
  isHost: boolean;
}

/** The shared, non-secret view of a room. Safe to send to every connection. */
export interface RoomSnapshot {
  code: string;
  phase: Phase;
  players: Player[];
}

/** Client -> server. */
export type ClientMessage =
  /** Claim a seat. `intent` distinguishes opening a new lobby from joining one. */
  | { type: "hello"; intent: "create" | "join"; name: string }
  /** Host only: remove a player and bar them from rejoining this room. */
  | { type: "kick"; playerId: string }
  /** Host only: hand the host role to another player. */
  | { type: "transferHost"; playerId: string }
  /** Host only: leave the lobby and begin the round. */
  | { type: "startGame" };

export type ErrorCode =
  | "room_not_found"
  | "name_taken"
  | "bad_message"
  | "not_host"
  | "unknown_player"
  | "kicked"
  | "not_enough_players"
  | "already_started";

/** Server -> client. */
export type ServerMessage =
  /** Full room state. Sent on join and after any change. */
  | { type: "snapshot"; room: RoomSnapshot; youId: string }
  /**
   * You were removed by the host. Sent immediately before the server closes the
   * connection, so the client can stop reconnecting instead of fighting to get
   * back into a room it is barred from.
   */
  | { type: "kicked"; byName: string }
  /** Recoverable problem, e.g. joining a code that was never created. */
  | { type: "error"; code: ErrorCode; message: string };

export const MAX_NAME_LENGTH = 16;

/**
 * Social deduction needs a crowd to hide in. With two players the Hacker is
 * whoever is not you, so the game does not exist below three. Shared by the
 * client (to gate the button) and the server (to enforce it).
 */
export const MIN_PLAYERS = 3;

/** Trim/clamp a display name. Returns null if nothing usable is left. */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);
  return name.length > 0 ? name : null;
}
