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
  | { type: "hello"; intent: "create" | "join"; name: string };

/** Server -> client. */
export type ServerMessage =
  /** Full room state. Sent on join and after any change. */
  | { type: "snapshot"; room: RoomSnapshot; youId: string }
  /** Recoverable problem, e.g. joining a code that was never created. */
  | { type: "error"; code: "room_not_found" | "name_taken" | "bad_message"; message: string };

export const MAX_NAME_LENGTH = 16;

/** Trim/clamp a display name. Returns null if nothing usable is left. */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);
  return name.length > 0 ? name : null;
}
