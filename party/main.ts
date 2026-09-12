import type * as Party from "partykit/server";
import {
  normalizeName,
  type ClientMessage,
  type Player,
  type RoomSnapshot,
  type ServerMessage,
  type Phase,
} from "../lib/protocol";

/**
 * One PartyKit room == one game lobby. `this.room.id` *is* the 6-char code.
 *
 * Authority model: the room server owns all shared state. Clients send intent,
 * never state. Later milestones lean on this — the host's browser generates the
 * packet feed, but the server decides who receives it (the Hacker must not).
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
      default:
        return this.sendError(sender, "bad_message", "Unknown message type.");
    }
  }

  private async onHello(
    msg: Extract<ClientMessage, { type: "hello" }>,
    sender: Party.Connection,
  ) {
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

    // First player in an empty lobby is the host (the packet-feed generator).
    const isHost = this.players.size === 0;
    this.players.set(sender.id, { id: sender.id, name, isHost });

    this.broadcastSnapshot();
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

    // Host generates the packet feed, so the room needs one at all times.
    if (departing.isHost) {
      const next = this.players.values().next();
      if (!next.done) next.value.isHost = true;
    }

    this.broadcastSnapshot();
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
      this.send(conn, { type: "snapshot", room, youId: conn.id });
    }
  }

  private sendError(
    conn: Party.Connection,
    code: Extract<ServerMessage, { type: "error" }>["code"],
    message: string,
  ) {
    this.send(conn, { type: "error", code, message });
  }

  private send(conn: Party.Connection, msg: ServerMessage) {
    conn.send(JSON.stringify(msg));
  }
}

NetsleuthRoom satisfies Party.Worker;
