import type * as Party from "partykit/server";
import {
  ATTACK_COOLDOWN_MS,
  COMPROMISE_COOLDOWN_MS,
  GLOBAL_ATTACK_COOLDOWN_MS,
  MEETING_MS,
  MIN_PLAYERS,
  ROUND_MS,
  SCAN_COOLDOWN_MS,
  SCAN_MS,
  STALL_MS,
  TAKEOVER_MS,
  TASKS_PER_PLAYER,
  normalizeName,
  type AnomalyKind,
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
import {
  activityPackets,
  compromisePackets,
  createNetwork,
  disruptPackets,
  scanPackets,
  spoofPackets,
  takeoverPackets,
  type Network,
  type RawPacket,
} from "../lib/packets";
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
 * state. Four rules carry the game:
 *
 *  1. Roles are per-connection and never appear on a snapshot.
 *  2. Addresses are per-connection too. You learn your own and nobody else's,
 *     which is what forces the hacker to hunt and the analysts to argue.
 *  3. The Hacker is never sent the packet feed at all.
 *  4. Task credit is decided here. A client reports that it *worked*, not that
 *     it *finished*, and the Hacker's work is silently discarded.
 *
 * Every packet on the wire is caused by a player, and every hostile act is
 * emitted from the acting player's own address. There is no ambient traffic to
 * hide in: the hacker's cover is doing fake work, not background noise.
 */
export default class NetsleuthRoom implements Party.Server {
  constructor(readonly room: Party.Room) {}

  private players = new Map<string, Player>();
  private phase: Phase = "lobby";
  private banned = new Map<string, string>();

  /** Secret. Never serialized into a snapshot. */
  private roles = new Map<string, Role>();
  /** Secret. Each player is told only their own. */
  private ips = new Map<string, string>();
  private tasks = new Map<string, Task[]>();
  private lastWorkAt = new Map<string, number>();

  /** Addresses the hacker has successfully swept for. Gates compromising. */
  private discovered = new Set<string>();
  private scanInFlight = false;
  private lastScanAt = 0;
  private lastCompromiseAt = 0;

  private network: Network = createNetwork();
  private deadline: number | null = null;
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;
  private roundEndsAt: number | null = null;
  private stalledUntil: number | null = null;

  private seq = 0;
  private anomalySeqs = new Map<number, AnomalyKind>();
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
      case "work":
        return this.onWork(msg, sender);
      case "attack":
        return this.onAttack(msg, sender);
      case "scan":
        return this.onScan(msg, sender);
      case "compromise":
        return this.onCompromise(msg, sender);
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
    // Preserve everything already decided, or a blip would reassign their
    // address mid-round and void every correlation the analysts had made.
    const existing = this.players.get(sender.id);
    this.players.set(sender.id, {
      id: sender.id,
      name,
      isHost: existing ? existing.isHost : this.players.size === 0,
      out: existing?.out ?? false,
      outReason: existing?.outReason ?? null,
      canCallMeeting: existing?.canCallMeeting ?? true,
    });
    if (!this.ips.has(sender.id)) this.ips.set(sender.id, this.nextIp());

    this.ensureHost();

    // Private state, re-sent so a reconnect does not land someone on the wrong
    // screen or leave them ignorant of their own address.
    this.send(sender, { type: "whoami", ip: this.ips.get(sender.id)! });
    const role = this.roles.get(sender.id);
    if (role) this.send(sender, { type: "role", role });
    const tasks = this.tasks.get(sender.id);
    if (tasks) this.send(sender, { type: "tasks", tasks });

    this.broadcastSnapshot();
  }

  /** Stable for the life of the room. Never broadcast. */
  private nextIp(): string {
    const used = new Set(this.ips.values());
    const base = this.network.gatewayIp.split(".").slice(0, 3).join(".");
    // Start high and scatter, so consecutive joiners do not get consecutive
    // addresses — join order would otherwise leak the mapping for free.
    const pool: string[] = [];
    for (let i = 20; i < 100; i++) {
      const ip = `${base}.${i}`;
      if (!used.has(ip)) pool.push(ip);
    }
    return pool[Math.floor(Math.random() * pool.length)] ?? `${base}.99`;
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
    this.roundEndsAt = null;
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
   * never reaches the shared total. With no ambient traffic to hide in, this is
   * the hacker's only cover.
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

  private progress(): Progress {
    let done = 0;
    let total = 0;
    for (const [id, list] of this.tasks) {
      const player = this.players.get(id);
      if (!player || player.out) continue;
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
    if (!player || player.out) {
      return this.sendError(sender, "out", "You are out of this round.");
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
      if (ejected) {
        ejected.out = true;
        ejected.outReason = "voted";
      }
      if (this.roles.get(ejectedId) === "hacker") {
        return this.endRound("hacker_ejected");
      }
    }

    if (this.remainingAnalysts() <= 1) return this.endRound("analysts_outnumbered");
    if (this.isWorkComplete()) return this.endRound("tasks_complete");

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
      (p) => !p.out && this.roles.get(p.id) === "benign",
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
        for (const s of flags) if (this.anomalySeqs.has(s)) hit++;
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

  private onWork(
    msg: Extract<ClientMessage, { type: "work" }>,
    sender: Party.Connection,
  ) {
    if (this.phase !== "playing") return;

    const player = this.players.get(sender.id);
    if (!player || player.out) return;

    if (this.stalledUntil !== null && Date.now() < this.stalledUntil) {
      return this.sendError(sender, "stalled", "The network is flooded. Work is stalled.");
    }

    const last = this.lastWorkAt.get(sender.id) ?? 0;
    const now = Date.now();
    if (now - last < MIN_WORK_INTERVAL_MS) return;
    this.lastWorkAt.set(sender.id, now);

    const list = this.tasks.get(sender.id);
    const task = list?.find((t) => t.id === msg.taskId);
    if (!list || !task || isComplete(task)) return;

    task.done++;
    this.send(sender, { type: "tasks", tasks: list });

    // The trail. Identical for both roles — this is what makes faked work
    // indistinguishable from real work on the wire.
    this.emit(
      activityPackets({
        from: this.ips.get(sender.id)!,
        gatewayIp: this.network.gatewayIp,
        seqFrom: this.seq,
        kind: task.kind,
      }),
    );

    // ...but only an analyst's work moves the shared bar.
    if (this.roles.get(sender.id) === "benign" && this.isWorkComplete()) {
      return this.endRound("tasks_complete");
    }

    this.broadcastSnapshot();
  }

  // --- hacker actions ------------------------------------------------------

  /** Shared gate for every hostile action. */
  private requireLiveHacker(sender: Party.Connection): string | null {
    if (this.phase !== "playing") {
      this.sendError(sender, "wrong_phase", "Not during a round.");
      return null;
    }
    if (this.roles.get(sender.id) !== "hacker") {
      this.sendError(sender, "not_hacker", "You are not the hacker.");
      return null;
    }
    const self = this.players.get(sender.id);
    if (!self || self.out) {
      this.sendError(sender, "out", "You are out of this round.");
      return null;
    }
    return this.ips.get(sender.id)!;
  }

  /**
   * An address sweep. It takes real time to come back and it is unmistakable in
   * the feed, so hunting a specific person is an act the room can see and
   * argue about — they just cannot tell *who* the scanning address belongs to.
   */
  private onScan(
    msg: Extract<ClientMessage, { type: "scan" }>,
    sender: Party.Connection,
  ) {
    const from = this.requireLiveHacker(sender);
    if (!from) return;

    if (this.scanInFlight) {
      return this.sendError(sender, "scanning", "A sweep is already running.");
    }
    const now = Date.now();
    if (now - this.lastScanAt < SCAN_COOLDOWN_MS) {
      return this.sendError(sender, "on_cooldown", "Sweep is still recharging.");
    }

    const target = this.players.get(msg.playerId);
    if (!target || target.out || target.id === sender.id) {
      return this.sendError(sender, "unknown_player", "Nothing to sweep for there.");
    }

    this.lastScanAt = now;
    this.scanInFlight = true;

    // Probe a handful of live addresses, not just the real target, so the feed
    // does not hand the analysts the victim's identity along with the scan.
    const live = [...this.players.values()]
      .filter((p) => !p.out && p.id !== sender.id)
      .map((p) => this.ips.get(p.id)!)
      .sort(() => Math.random() - 0.5);

    this.emit(
      scanPackets({
        from,
        gatewayIp: this.network.gatewayIp,
        seqFrom: this.seq,
        targets: live,
      }),
    );

    const delay = envMs(this.room.env, "SCAN_MS", SCAN_MS);
    setTimeout(() => {
      this.scanInFlight = false;
      const still = this.players.get(msg.playerId);
      const conn = this.room.getConnection(sender.id);
      if (!still || !conn) return;
      const ip = this.ips.get(msg.playerId)!;
      this.discovered.add(ip);
      this.send(conn, { type: "scanResult", playerId: still.id, name: still.name, ip });
    }, delay);
  }

  /**
   * The kill. Gated on having actually found the address: the hacker cannot
   * compromise someone they have not swept for, which is the whole point of
   * hiding the mapping in the first place.
   */
  private onCompromise(
    msg: Extract<ClientMessage, { type: "compromise" }>,
    sender: Party.Connection,
  ) {
    const from = this.requireLiveHacker(sender);
    if (!from) return;

    const now = Date.now();
    if (now - this.lastCompromiseAt < COMPROMISE_COOLDOWN_MS) {
      return this.sendError(sender, "on_cooldown", "Still too hot. Wait.");
    }
    if (!this.discovered.has(msg.ip)) {
      return this.sendError(sender, "unknown_ip", "You have not found that address.");
    }

    const victimId = [...this.ips.entries()].find(([, ip]) => ip === msg.ip)?.[0];
    const victim = victimId ? this.players.get(victimId) : undefined;
    if (!victim || victim.out || victim.id === sender.id) {
      return this.sendError(sender, "unknown_ip", "Nothing live at that address.");
    }

    this.lastCompromiseAt = now;
    victim.out = true;
    victim.outReason = "compromised";

    this.emit(
      compromisePackets({
        from,
        gatewayIp: this.network.gatewayIp,
        seqFrom: this.seq,
        victim: msg.ip,
      }),
    );

    const conn = this.room.getConnection(victim.id);
    if (conn) this.send(conn, { type: "compromised" });

    if (this.remainingAnalysts() <= 1) return this.endRound("analysts_outnumbered");
    // Their unfinished work leaves the denominator, which can complete the bar.
    if (this.isWorkComplete()) return this.endRound("tasks_complete");

    this.broadcastSnapshot();
  }

  private onAttack(
    msg: Extract<ClientMessage, { type: "attack" }>,
    sender: Party.Connection,
  ) {
    const from = this.requireLiveHacker(sender);
    if (!from) return;

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

    const ctx = { from, gatewayIp: this.network.gatewayIp, seqFrom: this.seq };

    if (kind === "spoof") {
      this.emit(spoofPackets(ctx));
    } else if (kind === "disrupt") {
      this.stalledUntil = now + STALL_MS;
      this.emit(disruptPackets(ctx));
      setTimeout(() => {
        if (this.stalledUntil !== null && Date.now() >= this.stalledUntil) {
          this.stalledUntil = null;
          this.broadcastSnapshot();
        }
      }, STALL_MS + 50);
    } else {
      const candidates = [...this.players.values()].filter(
        (p) => !p.out && this.roles.get(p.id) === "benign",
      );
      const victim = candidates[Math.floor(Math.random() * candidates.length)];
      if (victim) {
        this.emit(takeoverPackets({ ...ctx, victim: this.ips.get(victim.id)! }));
        const conn = this.room.getConnection(victim.id);
        if (conn) this.send(conn, { type: "takeover", untilMs: now + TAKEOVER_MS });
      }
    }

    this.broadcastSnapshot();
  }

  // --- the wire ------------------------------------------------------------

  /**
   * The single point where traffic reaches players, and the only place role
   * filtering happens. Ground truth is recorded here and stripped before
   * anything leaves, so no client is ever told which packets were hostile.
   */
  private emit(raws: RawPacket[]) {
    if (raws.length === 0) return;
    this.seq += raws.length;

    const clean: Packet[] = [];
    for (const raw of raws) {
      const { anomaly, ...packet } = raw;
      if (anomaly) {
        this.anomalySeqs.set(packet.seq, anomaly);
        this.seenSeqs.push(packet.seq);
      }
      this.recentPackets.set(packet.seq, packet);
      clean.push(packet);
    }
    this.trimTracked();

    for (const conn of this.room.getConnections()) {
      // Players who are out keep watching; they just cannot act.
      if (this.roles.get(conn.id) !== "benign") continue;
      this.send(conn, { type: "packets", packets: clean });
    }
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
    if (!player || player.out) return;

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
    if (!voter || voter.out) {
      return this.sendError(sender, "out", "You are out of this round.");
    }
    if (msg.targetId !== null) {
      const target = this.players.get(msg.targetId);
      if (!target || target.out) {
        return this.sendError(sender, "unknown_player", "That player is not in play.");
      }
    }

    this.votes.set(sender.id, msg.targetId);
    this.broadcastSnapshot();

    if (this.votes.size >= this.activePlayers()) this.resolveVote();
  }

  private activePlayers(): number {
    return [...this.players.values()].filter((p) => !p.out).length;
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
      gatewayIp: this.network.gatewayIp,
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
