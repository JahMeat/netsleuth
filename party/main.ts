import type * as Party from "partykit/server";
import {
  ATTACK_COOLDOWN_MS,
  GLOBAL_ATTACK_COOLDOWN_MS,
  MEETING_MS,
  MIN_PLAYERS,
  ROUND_MS,
  STALL_MS,
  TAKEOVER_MS,
  TASKS_PER_PLAYER,
  normalizeName,
  type AttackKind,
  type ClientMessage,
  type EndReason,
  type ErrorCode,
  type Evidence,
  type Packet,
  type Phase,
  type Player,
  type Progress,
  type Role,
  type RoomSnapshot,
  type RoundResult,
  type ServerMessage,
  type Vote,
} from "../lib/protocol";
import { activityPackets, createNetwork, type Network } from "../lib/packets";
import { createTaskList, doneSteps, isComplete, totalSteps, type Task } from "../lib/tasks";

/**
 * Round timings come from the shared constants, but any can be overridden with
 * a PartyKit var so a round can be shortened for playtesting or tests:
 *   npm run dev:party -- --var ROUND_MS=60000
 */
function envMs(env: Party.Room["env"], key: string, fallback: number): number {
  const raw = env?.[key];
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX_EVIDENCE = 40;
const MAX_TRACKED_SEQS = 4000;
/** Floor on the gap between two work units, so nobody can script a task. */
const MIN_WORK_INTERVAL_MS = 120;

/**
 * One PartyKit room == one game lobby. `this.room.id` *is* the 6-char code.
 *
 * The server owns all shared state and every secret. Clients send intent, never
 * state. Three rules carry the game:
 *
 *  1. Roles are per-connection and never appear on a snapshot.
 *  2. The Hacker is never sent the packet feed at all.
 *  3. Task credit is decided here. A client reports that it *worked*, not that
 *     it *finished*, and the Hacker's work is silently discarded — which is what
 *     makes their task list a convincing fake rather than a real one.
 */
export default class NetsleuthRoom implements Party.Server {
  constructor(readonly room: Party.Room) {}

  private players = new Map<string, Player>();
  private phase: Phase = "lobby";
  private banned = new Map<string, string>();

  /** Secret. Never serialized into a snapshot. */
  private roles = new Map<string, Role>();
  /** Secret per player: each sees only their own. */
  private tasks = new Map<string, Task[]>();
  private lastWorkAt = new Map<string, number>();

  private network: Network = createNetwork();
  private deadline: number | null = null;
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;
  private stalledUntil: number | null = null;

  /** Sequence numbers for packets the server emits itself. */
  private serverSeq = 1_000_000;

  private anomalySeqs = new Map<number, AttackKind>();
  private seenSeqs: number[] = [];
  private recentPackets = new Map<number, Packet>();

  private evidence: Evidence[] = [];
  private flaggedBy = new Map<string, Set<number>>();
  private votes = new Map<string, string | null>();
  private meetingCalledBy: string | null = null;
  private result: RoundResult | null = null;

  private lastAttackAt = 0;
  private lastAttackByKind = new Map<AttackKind, number>();
  private attacksLaunched = 0;

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
      case "startGame":
        return this.onStartGame(sender);
      case "feed":
        return this.onFeed(msg, sender);
      case "work":
        return this.onWork(msg, sender);
      case "attack":
        return this.onAttack(msg, sender);
      case "flag":
        return this.onFlag(msg, sender);
      case "callMeeting":
        return this.onCallMeeting(sender);
      case "vote":
        return this.onVote(msg, sender);
      default:
        return this.sendError(sender, "bad_message", "Unknown message type.");
    }
  }

  // --- lobby ---------------------------------------------------------------

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
      return this.sendError(
        sender,
        "room_not_found",
        `No lobby with code ${this.room.id}.`,
      );
    }

    const taken = [...this.players.values()].some(
      (p) => p.id !== sender.id && p.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken) {
      return this.sendError(sender, "name_taken", `"${name}" is already in this lobby.`);
    }

    // A reconnect re-sends `hello`, so this is an update as often as an insert.
    // Preserve everything already decided about them, or a blip would reassign
    // their IP mid-round and break every correlation the analysts had made.
    const existing = this.players.get(sender.id);
    this.players.set(sender.id, {
      id: sender.id,
      name,
      isHost: existing ? existing.isHost : this.players.size === 0,
      ip: existing?.ip ?? this.nextIp(),
      ejected: existing?.ejected ?? false,
      canCallMeeting: existing?.canCallMeeting ?? true,
    });

    this.ensureHost();

    // Someone reconnecting mid-round needs their private state back.
    const role = this.roles.get(sender.id);
    if (role) this.send(sender, { type: "role", role });
    const tasks = this.tasks.get(sender.id);
    if (tasks) this.send(sender, { type: "tasks", tasks });

    this.broadcastSnapshot();
  }

  /** Hand out LAN addresses that are stable for the life of the room. */
  private nextIp(): string {
    const used = new Set([...this.players.values()].map((p) => p.ip));
    const base = this.network.gateway.ip.split(".").slice(0, 3).join(".");
    // .20-.99 is the player range; ambient devices sit at .100+.
    for (let i = 20; i < 100; i++) {
      const ip = `${base}.${i}`;
      if (!used.has(ip)) return ip;
    }
    return `${base}.99`;
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

    const conn = this.room.getConnection(target.id);
    if (conn) {
      this.send(conn, { type: "kicked", byName: host.name });
      conn.close();
    }

    this.afterPlayerLeft(target.id);
  }

  private onTransferHost(
    msg: Extract<ClientMessage, { type: "transferHost" }>,
    sender: Party.Connection,
  ) {
    const host = this.requireHost(sender);
    if (!host) return;
    if (msg.playerId === sender.id) return;

    const target = this.players.get(msg.playerId);
    if (!target) {
      return this.sendError(sender, "unknown_player", "That player already left.");
    }

    host.isHost = false;
    target.isHost = true;
    this.broadcastSnapshot();
  }

  // --- round lifecycle -----------------------------------------------------

  private onStartGame(sender: Party.Connection) {
    if (!this.requireHost(sender)) return;
    if (this.phase !== "lobby") {
      return this.sendError(sender, "already_started", "The round has already begun.");
    }
    if (this.players.size < MIN_PLAYERS) {
      return this.sendError(
        sender,
        "not_enough_players",
        `Need at least ${MIN_PLAYERS} players to start.`,
      );
    }

    this.assignRoles();
    this.dealTasks();
    this.phase = "playing";
    this.setDeadline(envMs(this.room.env, "ROUND_MS", ROUND_MS), () =>
      this.endRound("time_expired"),
    );
    this.broadcastSnapshot();
  }

  private assignRoles() {
    const ids = [...this.players.keys()];
    const hackerId = ids[Math.floor(Math.random() * ids.length)];

    this.roles.clear();
    for (const id of ids) {
      const role: Role = id === hackerId ? "hacker" : "benign";
      this.roles.set(id, role);
      const conn = this.room.getConnection(id);
      if (conn) this.send(conn, { type: "role", role });
    }
  }

  /**
   * Everyone gets a list, the Hacker included. Theirs is real to them — it
   * advances, it completes, they can truthfully say they were working — it just
   * never reaches the shared total. Without this their IP would be silent and
   * they would be caught in the first thirty seconds.
   */
  private dealTasks() {
    this.tasks.clear();
    for (const id of this.players.keys()) {
      const list = createTaskList(Math.random, TASKS_PER_PLAYER);
      this.tasks.set(id, list);
      const conn = this.room.getConnection(id);
      if (conn) this.send(conn, { type: "tasks", tasks: list });
    }
  }

  /** Only real analysts' work counts toward the shared bar. */
  private progress(): Progress {
    let done = 0;
    let total = 0;
    for (const [id, list] of this.tasks) {
      const player = this.players.get(id);
      if (!player || player.ejected) continue;
      if (this.roles.get(id) !== "benign") continue;
      done += doneSteps(list);
      total += totalSteps(list);
    }
    return { done, total };
  }

  private onCallMeeting(sender: Party.Connection) {
    if (this.phase !== "playing") {
      return this.sendError(sender, "wrong_phase", "Not during a round.");
    }
    const player = this.players.get(sender.id);
    if (!player || player.ejected) {
      return this.sendError(sender, "ejected", "Spectators cannot call meetings.");
    }
    if (!player.canCallMeeting) {
      return this.sendError(sender, "no_meeting_left", "You already used your meeting.");
    }

    player.canCallMeeting = false;
    this.meetingCalledBy = player.name;
    this.phase = "meeting";
    this.votes.clear();
    this.setDeadline(envMs(this.room.env, "MEETING_MS", MEETING_MS), () =>
      this.resolveVote(),
    );
    this.broadcastSnapshot();
  }

  /**
   * Ejecting is not the end of the round unless it catches the Hacker. Everyone
   * else goes back to work with one fewer pair of hands.
   */
  private resolveVote() {
    if (this.phase !== "meeting") return;

    const tally = new Map<string, number>();
    for (const target of this.votes.values()) {
      if (target === null) continue;
      tally.set(target, (tally.get(target) ?? 0) + 1);
    }

    let ejectedId: string | null = null;
    let best = 0;
    let tied = false;
    for (const [id, n] of tally) {
      if (n > best) {
        best = n;
        ejectedId = id;
        tied = false;
      } else if (n === best) {
        tied = true;
      }
    }
    if (tied || best === 0) ejectedId = null;

    if (ejectedId) {
      const ejected = this.players.get(ejectedId);
      if (ejected) ejected.ejected = true;
      if (this.roles.get(ejectedId) === "hacker") {
        return this.endRound("hacker_ejected");
      }
    }

    // An ejected analyst's unfinished work leaves the denominator, so a wrong
    // vote costs the room time but never makes the bar unwinnable.
    if (this.remainingAnalysts() <= 1) {
      return this.endRound("analysts_outnumbered");
    }
    if (this.isWorkComplete()) {
      return this.endRound("tasks_complete");
    }

    this.phase = "playing";
    this.meetingCalledBy = null;
    this.votes.clear();
    // The round clock keeps its original end time; a meeting costs real time.
    const left = (this.roundEndsAt ?? Date.now()) - Date.now();
    if (left <= 0) return this.endRound("time_expired");
    this.setDeadline(left, () => this.endRound("time_expired"));
    this.broadcastSnapshot();
  }

  private remainingAnalysts(): number {
    return [...this.players.values()].filter(
      (p) => !p.ejected && this.roles.get(p.id) === "benign",
    ).length;
  }

  private isWorkComplete(): boolean {
    const p = this.progress();
    return p.total > 0 && p.done >= p.total;
  }

  private endRound(reason: EndReason) {
    if (this.phase === "ended") return;

    const hackerId = [...this.roles.entries()].find(([, r]) => r === "hacker")?.[0] ?? "";
    const hacker = this.players.get(hackerId);

    const hits = [...this.players.values()]
      .filter((p) => this.roles.get(p.id) === "benign")
      .map((p) => {
        const flags = this.flaggedBy.get(p.id) ?? new Set<number>();
        let hit = 0;
        for (const seq of flags) if (this.anomalySeqs.has(seq)) hit++;
        const list = this.tasks.get(p.id) ?? [];
        return {
          playerId: p.id,
          name: p.name,
          hits: hit,
          misses: flags.size - hit,
          tasksDone: list.filter(isComplete).length,
        };
      })
      .sort((a, b) => b.tasksDone - a.tasksDone || b.hits - a.hits);

    this.result = {
      hackerId,
      hackerName: hacker?.name ?? "(left the room)",
      benignWin: reason === "tasks_complete" || reason === "hacker_ejected",
      reason,
      progress: this.progress(),
      hits,
      attacksLaunched: this.attacksLaunched,
    };

    this.phase = "ended";
    this.clearDeadline();
    this.broadcastSnapshot();
  }

  /** Absolute end of the round, preserved across meetings. */
  private roundEndsAt: number | null = null;

  private setDeadline(ms: number, onExpiry: () => void) {
    this.clearDeadline();
    this.deadline = Date.now() + ms;
    if (this.phase === "playing") this.roundEndsAt ??= this.deadline;
    this.phaseTimer = setTimeout(onExpiry, ms);
  }

  private clearDeadline() {
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = null;
    this.deadline = null;
  }

  // --- work ----------------------------------------------------------------

  /**
   * One unit of work. The client says which task it touched; the server decides
   * whether that means anything. Either way it emits packets from the player's
   * own IP, because looking busy is the point for both roles.
   */
  private onWork(
    msg: Extract<ClientMessage, { type: "work" }>,
    sender: Party.Connection,
  ) {
    if (this.phase !== "playing") return;

    const player = this.players.get(sender.id);
    if (!player || player.ejected) return;

    if (this.stalledUntil !== null && Date.now() < this.stalledUntil) {
      return this.sendError(sender, "stalled", "The network is flooded. Work is stalled.");
    }

    // Cheap rate limit: a human cannot out-click this, a script can.
    const last = this.lastWorkAt.get(sender.id) ?? 0;
    const now = Date.now();
    if (now - last < MIN_WORK_INTERVAL_MS) return;
    this.lastWorkAt.set(sender.id, now);

    const list = this.tasks.get(sender.id);
    const task = list?.find((t) => t.id === msg.taskId);
    if (!list || !task || isComplete(task)) return;

    task.done++;
    this.send(sender, { type: "tasks", tasks: list });

    // The trail. Identical for both roles — this is what makes a Hacker's
    // faked work indistinguishable from real work in the feed.
    this.emitActivity(player.ip, task.kind);

    // ...but only an analyst's work moves the shared bar.
    if (this.roles.get(sender.id) === "benign" && this.isWorkComplete()) {
      return this.endRound("tasks_complete");
    }

    this.broadcastSnapshot();
  }

  private emitActivity(ip: string, kind: Task["kind"]) {
    const raws = activityPackets({
      ip,
      kind,
      seqFrom: this.serverSeq,
      gatewayIp: this.network.gateway.ip,
    });
    this.serverSeq += raws.length;

    const clean: Packet[] = [];
    for (const raw of raws) {
      const { anomaly: _drop, ...packet } = raw;
      this.recentPackets.set(packet.seq, packet);
      clean.push(packet);
    }
    this.fanOutToAnalysts(clean);
  }

  // --- the ambient feed ----------------------------------------------------

  /**
   * Background noise from the host's browser. Activity packets do not come
   * through here — they are emitted by the server from validated work — but the
   * fan-out rule is the same, and it is the only place role filtering happens.
   */
  private onFeed(
    msg: Extract<ClientMessage, { type: "feed" }>,
    sender: Party.Connection,
  ) {
    const host = this.players.get(sender.id);
    if (!host?.isHost) return this.sendError(sender, "not_host", "Only the host feeds.");
    if (this.phase !== "playing") return;
    if (!Array.isArray(msg.packets)) return;

    const clean: Packet[] = [];
    for (const raw of msg.packets) {
      const { anomaly, ...packet } = raw;
      if (anomaly) this.trackAnomaly(packet.seq, anomaly);
      this.recentPackets.set(packet.seq, packet);
      clean.push(packet);
    }
    this.trimTracked();
    this.fanOutToAnalysts(clean);
  }

  private fanOutToAnalysts(packets: Packet[]) {
    if (packets.length === 0) return;
    for (const conn of this.room.getConnections()) {
      // Ejected players keep watching — they just cannot act any more.
      const role = this.roles.get(conn.id);
      if (role !== "benign") continue;
      this.send(conn, { type: "packets", packets });
    }
  }

  private trackAnomaly(seq: number, kind: AttackKind) {
    this.anomalySeqs.set(seq, kind);
    this.seenSeqs.push(seq);
  }

  private trimTracked() {
    while (this.seenSeqs.length > MAX_TRACKED_SEQS) {
      const old = this.seenSeqs.shift();
      if (old !== undefined) this.anomalySeqs.delete(old);
    }
    if (this.recentPackets.size > MAX_TRACKED_SEQS) {
      const cutoff = this.recentPackets.size - MAX_TRACKED_SEQS;
      let i = 0;
      for (const key of this.recentPackets.keys()) {
        if (i++ >= cutoff) break;
        this.recentPackets.delete(key);
      }
    }
  }

  // --- hacker actions ------------------------------------------------------

  private onAttack(
    msg: Extract<ClientMessage, { type: "attack" }>,
    sender: Party.Connection,
  ) {
    if (this.phase !== "playing") {
      return this.sendError(sender, "wrong_phase", "Not during a round.");
    }
    if (this.roles.get(sender.id) !== "hacker") {
      return this.sendError(sender, "not_hacker", "You are not the hacker.");
    }
    const self = this.players.get(sender.id);
    if (!self || self.ejected) {
      return this.sendError(sender, "ejected", "You have been ejected.");
    }

    const kind = msg.kind;
    if (kind !== "spoof" && kind !== "disrupt" && kind !== "takeover") {
      return this.sendError(sender, "bad_message", "Unknown attack.");
    }

    const now = Date.now();
    if (now - this.lastAttackAt < GLOBAL_ATTACK_COOLDOWN_MS) {
      return this.sendError(sender, "on_cooldown", "Too soon after your last attack.");
    }
    if (now - (this.lastAttackByKind.get(kind) ?? -Infinity) < ATTACK_COOLDOWN_MS) {
      return this.sendError(sender, "on_cooldown", "That attack is still recharging.");
    }

    this.lastAttackAt = now;
    this.lastAttackByKind.set(kind, now);
    this.attacksLaunched++;

    // Attacks are worth the exposure because they buy time against the bar.
    if (kind === "disrupt") {
      this.stalledUntil = now + STALL_MS;
      setTimeout(() => {
        if (this.stalledUntil !== null && Date.now() >= this.stalledUntil) {
          this.stalledUntil = null;
          this.broadcastSnapshot();
        }
      }, STALL_MS + 50);
    }

    let victimLabel: string | undefined;
    if (kind === "takeover") {
      const candidates = [...this.players.values()].filter(
        (p) => !p.ejected && this.roles.get(p.id) === "benign",
      );
      const victim = candidates[Math.floor(Math.random() * candidates.length)];
      const conn = victim ? this.room.getConnection(victim.id) : null;
      if (conn) this.send(conn, { type: "takeover", untilMs: now + TAKEOVER_MS });
      victimLabel = victim?.name;
    }

    const hostId = [...this.players.values()].find((p) => p.isHost)?.id;
    const hostConn = hostId ? this.room.getConnection(hostId) : null;
    if (hostConn) this.send(hostConn, { type: "inject", kind, victimLabel });

    this.broadcastSnapshot();
  }

  // --- analyst actions -----------------------------------------------------

  private onFlag(
    msg: Extract<ClientMessage, { type: "flag" }>,
    sender: Party.Connection,
  ) {
    if (this.phase !== "playing") {
      return this.sendError(sender, "wrong_phase", "Not during a round.");
    }
    if (this.roles.get(sender.id) !== "benign") {
      return this.sendError(sender, "bad_message", "Only analysts can flag.");
    }

    const player = this.players.get(sender.id);
    if (!player || player.ejected) return;

    let flags = this.flaggedBy.get(sender.id);
    if (!flags) this.flaggedBy.set(sender.id, (flags = new Set()));
    if (flags.has(msg.seq)) return;
    flags.add(msg.seq);

    const kind = this.anomalySeqs.get(msg.seq) ?? null;
    const hit = kind !== null;
    const packet = this.recentPackets.get(msg.seq);

    if (packet) {
      this.evidence.push({
        seq: msg.seq,
        packet,
        byId: sender.id,
        byName: player.name,
        hit,
        kind,
      });
      if (this.evidence.length > MAX_EVIDENCE) this.evidence.shift();
    }

    this.send(sender, { type: "flagAck", seq: msg.seq, hit });
  }

  private onVote(
    msg: Extract<ClientMessage, { type: "vote" }>,
    sender: Party.Connection,
  ) {
    if (this.phase !== "meeting") {
      return this.sendError(sender, "wrong_phase", "There is no vote open.");
    }
    const voter = this.players.get(sender.id);
    if (!voter || voter.ejected) {
      return this.sendError(sender, "ejected", "Spectators do not vote.");
    }
    if (msg.targetId !== null) {
      const target = this.players.get(msg.targetId);
      if (!target || target.ejected) {
        return this.sendError(sender, "unknown_player", "That player is not in play.");
      }
    }

    this.votes.set(sender.id, msg.targetId);
    this.broadcastSnapshot();

    if (this.votes.size >= this.activePlayers()) this.resolveVote();
  }

  private activePlayers(): number {
    return [...this.players.values()].filter((p) => !p.ejected).length;
  }

  // --- membership ----------------------------------------------------------

  onClose(conn: Party.Connection) {
    if (this.players.delete(conn.id)) this.afterPlayerLeft(conn.id);
  }

  onError(conn: Party.Connection) {
    if (this.players.delete(conn.id)) this.afterPlayerLeft(conn.id);
  }

  private afterPlayerLeft(id: string) {
    this.ensureHost();
    this.votes.delete(id);

    if (this.phase === "playing" || this.phase === "meeting") {
      if (this.roles.get(id) === "hacker") return this.endRound("hacker_left");
      if (this.remainingAnalysts() <= 1) return this.endRound("analysts_outnumbered");
      // Their unfinished work leaves the denominator, which can complete the bar.
      if (this.isWorkComplete()) return this.endRound("tasks_complete");
      if (this.phase === "meeting" && this.votes.size >= this.activePlayers()) {
        return this.resolveVote();
      }
    }

    this.broadcastSnapshot();
  }

  private ensureHost() {
    if (this.players.size === 0) return;
    const hosts = [...this.players.values()].filter((p) => p.isHost);
    if (hosts.length === 1) return;

    for (const p of this.players.values()) p.isHost = false;
    const [first] = hosts.length > 1 ? hosts : [...this.players.values()];
    first.isHost = true;
  }

  private requireHost(sender: Party.Connection): Player | null {
    const player = this.players.get(sender.id);
    if (!player?.isHost) {
      this.sendError(sender, "not_host", "Only the host can do that.");
      return null;
    }
    return player;
  }

  // --- plumbing ------------------------------------------------------------

  private snapshot(): RoomSnapshot {
    return {
      code: this.room.id,
      phase: this.phase,
      players: [...this.players.values()],
      deadline: this.deadline,
      progress: this.progress(),
      gatewayIp: this.network.gateway.ip,
      stalledUntil: this.stalledUntil,
      meetingCalledBy: this.meetingCalledBy,
      evidence: this.phase === "meeting" || this.phase === "ended" ? this.evidence : [],
      votes: this.phase === "meeting" ? this.voteList() : [],
      result: this.result,
    };
  }

  private voteList(): Vote[] {
    return [...this.votes.entries()].map(([voterId, targetId]) => ({ voterId, targetId }));
  }

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
