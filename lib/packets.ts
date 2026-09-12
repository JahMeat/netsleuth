/**
 * Packet construction.
 *
 * Everything on the wire is caused by a player. There is no ambient traffic and
 * no outside hosts: every source address belongs to someone in this room, or to
 * the gateway answering one of them. That is what makes the feed readable as a
 * record of people rather than a networking puzzle.
 *
 * The rule that carries the game: *every hostile action emits from the hacker's
 * own address*. Scanning, compromising and attacking all leave the same
 * fingerprint, so the analysts' job is to notice which address misbehaves and
 * then work out who is sitting behind it.
 *
 * Pure and dependency-free, so it runs under plain Node.
 */

export type AttackKind = "spoof" | "disrupt" | "takeover";

/** Ground-truth tag on a packet. Never sent to a player. */
export type AnomalyKind = AttackKind | "scan" | "compromise";

/** What the analyst sees. No ground truth — that would give the game away. */
export interface Packet {
  seq: number;
  t: number;
  src: string;
  dst: string;
  srcPort: number | null;
  dstPort: number | null;
  proto: string;
  flags: string;
  len: number;
  info: string;
}

/** What the builders produce. The server strips `anomaly` before forwarding. */
export interface RawPacket extends Packet {
  anomaly: AnomalyKind | null;
}

export type TaskKind = "type" | "click" | "wind";

function int(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

function hex(rand: () => number, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += "0123456789abcdef"[Math.floor(rand() * 16)];
  return out;
}

function mac(rand: () => number): string {
  return Array.from({ length: 6 }, () => hex(rand, 2)).join(":");
}

/** The LAN this round happens on. Players get addresses; nothing else exists. */
export interface Network {
  gatewayIp: string;
  gatewayMac: string;
}

export function createNetwork(rand: () => number = Math.random): Network {
  return {
    gatewayIp: `192.168.${int(rand, 1, 20)}.1`,
    gatewayMac: mac(rand),
  };
}

interface BuildContext {
  /** Address of whoever caused this. */
  from: string;
  gatewayIp: string;
  seqFrom: number;
  rand?: () => number;
}

function builder(ctx: BuildContext) {
  let seq = ctx.seqFrom;
  const t = Date.now();
  return (p: Omit<RawPacket, "seq" | "t">): RawPacket => ({ ...p, seq: seq++, t });
}

/**
 * Ordinary work. This is the only traffic that is not hostile, which means an
 * address producing none of it has done nothing all round.
 */
export function activityPackets(ctx: BuildContext & { kind: TaskKind }): RawPacket[] {
  const rand = ctx.rand ?? Math.random;
  const mk = builder(ctx);
  const { from, gatewayIp } = ctx;

  if (ctx.kind === "type") {
    return [
      mk({
        src: from,
        dst: gatewayIp,
        srcPort: int(rand, 49152, 65535),
        dstPort: 443,
        proto: "HTTP",
        flags: "PSH,ACK",
        len: int(rand, 180, 420),
        info: `POST /api/notes keystroke batch (${int(rand, 3, 14)} chars)`,
        anomaly: null,
      }),
    ];
  }

  if (ctx.kind === "click") {
    return [
      mk({
        src: from,
        dst: gatewayIp,
        srcPort: int(rand, 49152, 65535),
        dstPort: 443,
        proto: "HTTP",
        flags: "PSH,ACK",
        len: int(rand, 120, 260),
        info: `POST /api/actions/ack id=${int(rand, 1000, 9999)}`,
        anomaly: null,
      }),
    ];
  }

  return [
    mk({
      src: from,
      dst: gatewayIp,
      srcPort: int(rand, 49152, 65535),
      dstPort: 443,
      proto: "WS",
      flags: "PSH,ACK",
      len: int(rand, 60, 140),
      info: `WebSocket frame: relay.step seq=${int(rand, 1, 999)}`,
      anomaly: null,
    }),
    mk({
      src: gatewayIp,
      dst: from,
      srcPort: 443,
      dstPort: int(rand, 49152, 65535),
      proto: "WS",
      flags: "ACK",
      len: 66,
      info: "WebSocket frame: relay.ack",
      anomaly: null,
    }),
  ];
}

/**
 * Reconnaissance: an ARP sweep hunting for live hosts.
 *
 * Deliberately unmistakable. Hunting someone has to be an act the room can see,
 * or the hacker gets their kill for free.
 */
export function scanPackets(ctx: BuildContext & { targets: string[] }): RawPacket[] {
  const rand = ctx.rand ?? Math.random;
  const mk = builder(ctx);
  const { from, gatewayIp } = ctx;

  const out: RawPacket[] = [
    mk({
      src: from,
      dst: "255.255.255.255",
      srcPort: null,
      dstPort: null,
      proto: "ARP",
      flags: "",
      len: 42,
      info: `Who has ${gatewayIp.replace(/\.1$/, ".0")}/24? (address sweep)`,
      anomaly: "scan",
    }),
  ];

  for (const target of ctx.targets.slice(0, 4)) {
    out.push(
      mk({
        src: from,
        dst: target,
        srcPort: int(rand, 49152, 65535),
        dstPort: int(rand, 1, 1024),
        proto: "TCP",
        flags: "SYN",
        len: 58,
        info: `Probe ${target} — host discovery`,
        anomaly: "scan",
      }),
    );
  }
  return out;
}

/** The kill. Credentials replayed against a host that then stops answering. */
export function compromisePackets(ctx: BuildContext & { victim: string }): RawPacket[] {
  const rand = ctx.rand ?? Math.random;
  const mk = builder(ctx);
  const { from, victim } = ctx;

  return [
    mk({
      src: from,
      dst: victim,
      srcPort: int(rand, 49152, 65535),
      dstPort: 22,
      proto: "SSH",
      flags: "PSH,ACK",
      len: 312,
      info: `Auth attempt on ${victim} — replayed session key`,
      anomaly: "compromise",
    }),
    mk({
      src: victim,
      dst: from,
      srcPort: 22,
      dstPort: int(rand, 49152, 65535),
      proto: "SSH",
      flags: "PSH,ACK",
      len: 148,
      info: "Auth accepted — new shell opened",
      anomaly: "compromise",
    }),
    mk({
      src: from,
      dst: victim,
      srcPort: int(rand, 49152, 65535),
      dstPort: 22,
      proto: "SSH",
      flags: "PSH,ACK",
      len: 96,
      info: `Account on ${victim} locked out`,
      anomaly: "compromise",
    }),
  ];
}

/** ARP spoof: the gateway address starts answering from somewhere else. */
export function spoofPackets(ctx: BuildContext): RawPacket[] {
  const rand = ctx.rand ?? Math.random;
  const mk = builder(ctx);
  const { from, gatewayIp } = ctx;
  const rogue = mac(rand);

  return [
    mk({
      src: from,
      dst: "255.255.255.255",
      srcPort: null,
      dstPort: null,
      proto: "ARP",
      flags: "",
      len: 42,
      info: `${gatewayIp} is at ${rogue} (duplicate use of ${gatewayIp} detected)`,
      anomaly: "spoof",
    }),
    mk({
      src: from,
      dst: gatewayIp,
      srcPort: null,
      dstPort: null,
      proto: "ARP",
      flags: "",
      len: 42,
      info: "Gratuitous ARP — default gateway MAC changed mid-session",
      anomaly: "spoof",
    }),
  ];
}

/** SYN flood aimed at the gateway: everyone's work stalls behind it. */
export function disruptPackets(ctx: BuildContext): RawPacket[] {
  const rand = ctx.rand ?? Math.random;
  const mk = builder(ctx);
  const { from, gatewayIp } = ctx;

  const out: RawPacket[] = [];
  let port = int(rand, 1024, 4096);
  for (let i = 0; i < 10; i++) {
    port += int(rand, 1, 3);
    out.push(
      mk({
        src: from,
        dst: gatewayIp,
        srcPort: int(rand, 1024, 65535),
        dstPort: port,
        proto: "TCP",
        flags: "SYN",
        len: 60,
        info:
          i > 4 && rand() < 0.5
            ? "[TCP Retransmission] Seq=0 Win=1024 Len=0"
            : "Seq=0 Win=1024 Len=0 MSS=1460",
        anomaly: "disrupt",
      }),
    );
  }
  return out;
}

/** Session hijack: a live conversation changes hands. */
export function takeoverPackets(ctx: BuildContext & { victim: string }): RawPacket[] {
  const rand = ctx.rand ?? Math.random;
  const mk = builder(ctx);
  const { from, victim } = ctx;
  const before = int(rand, 1000, 900000);
  const jumped = before + int(rand, 900000, 4000000);

  return [
    mk({
      src: from,
      dst: victim,
      srcPort: 49712,
      dstPort: 4444,
      proto: "TCP",
      flags: "PSH,ACK",
      len: 214,
      info: `Seq=${jumped} (previous Seq=${before}) — sequence jump`,
      anomaly: "takeover",
    }),
    mk({
      src: victim,
      dst: from,
      srcPort: 4444,
      dstPort: 49712,
      proto: "TELNET",
      flags: "PSH,ACK",
      len: 97,
      info: "Session switched TLS -> TELNET on established stream",
      anomaly: "takeover",
    }),
  ];
}

/** Strip ground truth. Anything sent to a player must go through this. */
export function sanitize(p: RawPacket): Packet {
  const { anomaly: _drop, ...rest } = p;
  return rest;
}
