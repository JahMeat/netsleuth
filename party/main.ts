import type * as Party from "partykit/server";
import {
  normalizeName,
  type ClientMessage,
  type ErrorCode,
  type Player,
  type RoomSnapshot,
  type ServerMessage,
  type Phase,
} from "../lib/protocol";

/**
 * One PartyKit room == one game lobby. `this.room.id` *is* the 6-char code.
 *
 * Authority model: the room server owns all shared state. Clients send intent,
 * never state. Every host-only action is re-checked here — a client claiming to
 * be the host proves nothing. Later milestones lean on this same boundary: the
 * host's browser generates the packet feed, but the server decides who receives
 * it (the Hacker must not).
 */
export default class NetsleuthRoom implements Party.Server {
  constructor(readonly room: Party.Room) {}

  /**
   * Players are in-memory and keyed by connection id: they are inherently
   * ephemeral, so there is nothing to persist. The one thing we *do* persist is
   * the "this code was deliberately created" marker, so that a room which goes
   * idle (all players gone) can still be rejoined rather than being silently
   * re-created by a typo'd code.
   */
  private players = new Map<string, Player>();
  private phase: Phase = "lobby";

  /**
   * Connection ids the host has ejected. Kept for the room's lifetime so a kick
   * is not undone one second later by partysocket's automatic reconnect. This
   * is deliberately not airtight — a determined player can clear sessionStorage
   * for a fresh id — but it stops the accidental and the lazy, which is the
   * realistic failure mode in a room full of people who know each other.
   */
  private banned = new Map<string, string>();

  async onMessage(raw: string, sender: Party.Connection) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return this.sendError(sender, "bad_message", "Malformed message.");
    }

    switch (msg?.type) {
      case "hello":
        return this.onHello(msg, sender);
      case "kick":
        return this.onKick(msg, sender);
      case "transferHost":
        return this.onTransferHost(msg, sender);
      default:
        return this.sendError(sender, "bad_message", "Unknown message type.");
    }
  }

  private async onHello(
    msg: Extract<ClientMessage, { type: "hello" }>,
    sender: Party.Connection,
  ) {
    const bannedBy = this.banned.get(sender.id);
    if (bannedBy !== undefined) {
      this.send(sender, { type: "kicked", byName: bannedBy });
      return sender.close();
    }

    const name = normalizeName(msg.name);
    if (!name) {
      return this.sendError(sender, "bad_message", "A display name is required.");
    }

    const wasCreated = (await this.room.storage.get<boolean>("created")) ?? false;

    if (msg.intent === "create") {
      if (!wasCreated) await this.room.storage.put("created", true);
    } else if (!wasCreated) {
      // Joining a code nobody ever created. Refuse rather than opening an
      // empty lobby that looks real but nobody else will ever arrive in.
      return this.sendError(
        sender,
        "room_not_found",
        `No lobby with code ${this.room.id}.`,
      );
    }

    // Names are how players accuse each other, so collisions are confusing.
    const taken = [...this.players.values()].some(
      (p) => p.id !== sender.id && p.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken) {
      return this.sendError(sender, "name_taken", `"${name}" is already in this lobby.`);
    }

    // A reconnecting player re-sends `hello`, so this is an update as often as
    // it is an insert. Preserve the existing host flag: recomputing it here
    // would silently demote a host whose socket merely blipped.
    const existing = this.players.get(sender.id);
    const isHost = existing ? existing.isHost : this.players.size === 0;
    this.players.set(sender.id, { id: sender.id, name, isHost });

    this.ensureHost();
    this.broadcastSnapshot();
  }

  private onKick(
    msg: Extract<ClientMessage, { type: "kick" }>,
    sender: Party.Connection,
  ) {
    const host = this.requireHost(sender);
    if (!host) return;

    if (msg.playerId === sender.id) {
      return this.sendError(sender, "bad_message", "You cannot kick yourself.");
    }

    const target = this.players.get(msg.playerId);
    if (!target) {
      return this.sendError(sender, "unknown_player", "That player already left.");
    }

    this.banned.set(target.id, host.name);
    this.players.delete(target.id);

    // Tell them why before cutting the connection, so their client can stop
    // reconnecting and show something better than a bare "disconnected".
    const conn = this.room.getConnection(target.id);
    if (conn) {
      this.send(conn, { type: "kicked", byName: host.name });
      conn.close();
    }

    this.broadcastSnapshot();
  }

  private onTransferHost(
    msg: Extract<ClientMessage, { type: "transferHost" }>,
    sender: Party.Connection,
  ) {
    const host = this.requireHost(sender);
    if (!host) return;

    if (msg.playerId === sender.id) return; // Already the host; nothing to do.

    const target = this.players.get(msg.playerId);
    if (!target) {
      return this.sendError(sender, "unknown_player", "That player already left.");
    }

    host.isHost = false;
    target.isHost = true;

    this.broadcastSnapshot();
  }

  /** Returns the sender's player record only if they really are the host. */
  private requireHost(sender: Party.Connection): Player | null {
    const player = this.players.get(sender.id);
    if (!player?.isHost) {
      this.sendError(sender, "not_host", "Only the host can do that.");
      return null;
    }
    return player;
  }

  onClose(conn: Party.Connection) {
    this.removePlayer(conn.id);
  }

  onError(conn: Party.Connection) {
    this.removePlayer(conn.id);
  }

  private removePlayer(id: string) {
    const departing = this.players.get(id);
    if (!departing) return;
    this.players.delete(id);

    this.ensureHost();
    this.broadcastSnapshot();
  }

  /**
   * The room must always have exactly one host while anyone is in it, since the
   * host's browser is what generates the packet feed. Called after any change to
   * the player set rather than only on disconnect, so there is no ordering of
   * joins, leaves and transfers that can leave the room headless.
   */
  private ensureHost() {
    if (this.players.size === 0) return;
    const hosts = [...this.players.values()].filter((p) => p.isHost);
    if (hosts.length === 1) return;

    // Keep the longest-standing host on a tie, otherwise promote the oldest player.
    for (const p of this.players.values()) p.isHost = false;
    const [first] = hosts.length > 1 ? hosts : [...this.players.values()];
    first.isHost = true;
  }

  private snapshot(): RoomSnapshot {
    return {
      code: this.room.id,
      phase: this.phase,
      players: [...this.players.values()],
    };
  }

  /**
   * Snapshots carry no secrets, but `youId` differs per connection so each
   * client can pick itself out of the player list. Hence per-connection sends
   * rather than a single room-wide broadcast.
   */
  private broadcastSnapshot() {
    const room = this.snapshot();
    for (const conn of this.room.getConnections()) {
      if (this.banned.has(conn.id)) continue;
      this.send(conn, { type: "snapshot", room, youId: conn.id });
    }
  }

  private sendError(conn: Party.Connection, code: ErrorCode, message: string) {
    this.send(conn, { type: "error", code, message });
  }

  private send(conn: Party.Connection, msg: ServerMessage) {
    conn.send(JSON.stringify(msg));
  }
}

NetsleuthRoom satisfies Party.Worker;
