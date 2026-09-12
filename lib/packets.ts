/**
 * Fake packet feed generation.
 *
 * Deliberately dependency-free and deterministic given an `rand` function, so
 * it can be exercised straight from Node without a browser, a socket, or React.
 * Nothing in here knows about PartyKit or the game — it just produces plausible
 * traffic, and on request splices in one of three attack signatures.
 */

export type AttackKind = "spoof" | "disrupt" | "takeover";

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

/** What the generator produces. The server strips `anomaly` before forwarding. */
export interface RawPacket extends Packet {
  anomaly: AttackKind | null;
}

export interface Host {
  ip: string;
  mac: string;
  label: string;
}

export interface Network {
  gateway: Host;
  hosts: Host[];
  externals: { ip: string; label: string }[];
}

const HOST_LABELS = [
  "workstation",
  "laptop",
  "print-srv",
  "nas",
  "cam-01",
  "voip-phone",
  "tablet",
];

const EXTERNALS = [
  { ip: "142.250.72.14", label: "cdn" },
  { ip: "151.101.1.69", label: "news" },
  { ip: "52.94.236.248", label: "cloud" },
  { ip: "104.18.32.47", label: "api" },
  { ip: "34.107.221.82", label: "telemetry" },
];

function hex(rand: () => number, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += "0123456789abcdef"[Math.floor(rand() * 16)];
  return out;
}

function mac(rand: () => number): string {
  return Array.from({ length: 6 }, () => hex(rand, 2)).join(":");
}

function pick<T>(rand: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rand() * xs.length)];
}

function int(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/** Builds the little LAN the round takes place on. */
export function createNetwork(rand: () => number = Math.random): Network {
  const subnet = `192.168.${int(rand, 1, 20)}`;
  const gateway: Host = {
    ip: `${subnet}.1`,
    mac: mac(rand),
    label: "gateway",
  };
  const hosts = HOST_LABELS.map((label, i) => ({
    ip: `${subnet}.${20 + i * 3 + int(rand, 0, 2)}`,
    mac: mac(rand),
    label,
  }));
  return { gateway, hosts, externals: EXTERNALS };
}

const SERVICE_PORTS = [443, 443, 443, 80, 53, 123, 993, 5228] as const;
const TCP_FLAGS = ["PSH,ACK", "ACK", "ACK", "FIN,ACK", "SYN,ACK"] as const;

/**
 * A live feed. Holds the mutable bits normal traffic needs to look continuous:
 * sequence numbers per conversation, and a queue of attack packets waiting to
 * be interleaved so a burst arrives over several ticks instead of all at once.
 */
export interface Feed {
  /** Produce the packets for one tick. */
  tick: () => RawPacket[];
  /** Queue an attack. Its packets surface across the next few ticks. */
  inject: (kind: AttackKind, victimLabel?: string) => void;
  network: Network;
}

export function createFeed(options?: {
  rand?: () => number;
  network?: Network;
  /** Packets of ordinary traffic per tick. */
  rate?: number;
}): Feed {
  const rand = options?.rand ?? Math.random;
  const network = options?.network ?? createNetwork(rand);
  const baseRate = options?.rate ?? 3;

  let seq = 0;
  const tcpSeq = new Map<string, number>();
  const queued: RawPacket[][] = [];

  function nextTcpSeq(key: string, by: number): number {
    const cur = tcpSeq.get(key) ?? int(rand, 1000, 900000);
    const next = cur + by;
    tcpSeq.set(key, next);
    return next;
  }

  // seq is assigned at emit time, not here: attack packets are built in advance
  // and spliced into a later tick, so numbering them on creation would make the
  // feed read out of order on screen.
  function make(p: Omit<RawPacket, "seq" | "t">): RawPacket {
    return { ...p, seq: -1, t: 0 };
  }

  /** One unremarkable packet. */
  function normal(): RawPacket {
    const host = pick(rand, network.hosts);
    const roll = rand();

    if (roll < 0.1) {
      const ext = pick(rand, network.externals);
      return make({
        src: host.ip,
        dst: network.gateway.ip,
        srcPort: int(rand, 49152, 65535),
        dstPort: 53,
        proto: "DNS",
        flags: "",
        len: int(rand, 60, 120),
        info: `Standard query A ${ext.label}.example.net`,
        anomaly: null,
      });
    }

    if (roll < 0.16) {
      return make({
        src: host.ip,
        dst: network.gateway.ip,
        srcPort: null,
        dstPort: null,
        proto: "ICMP",
        flags: "",
        len: 74,
        info: "Echo (ping) request",
        anomaly: null,
      });
    }

    if (roll < 0.22) {
      return make({
        src: host.ip,
        dst: "255.255.255.255",
        srcPort: null,
        dstPort: null,
        proto: "ARP",
        flags: "",
        len: 42,
        info: `Who has ${network.gateway.ip}? Tell ${host.ip}`,
        anomaly: null,
      });
    }

    const ext = pick(rand, network.externals);
    const outbound = rand() < 0.55;
    const len = int(rand, 66, 1454);
    const key = `${host.ip}:${ext.ip}`;
    const s = nextTcpSeq(key, len - 66);

    return make({
      src: outbound ? host.ip : ext.ip,
      dst: outbound ? ext.ip : host.ip,
      srcPort: outbound ? int(rand, 49152, 65535) : pick(rand, SERVICE_PORTS),
      dstPort: outbound ? pick(rand, SERVICE_PORTS) : int(rand, 49152, 65535),
      proto: rand() < 0.75 ? "TLS" : "TCP",
      flags: pick(rand, TCP_FLAGS),
      len,
      info:
        rand() < 0.6
          ? `Application Data, Seq=${s}`
          : `${int(rand, 1, 3)} segment(s), Seq=${s} Win=${int(rand, 501, 64240)}`,
      anomaly: null,
    });
  }

  /**
   * ARP/IP spoof. The tell: the gateway IP suddenly answers from a MAC that is
   * not the gateway's, so two MACs claim one address.
   */
  function spoof(): RawPacket[][] {
    const attacker = mac(rand);
    const victim = pick(rand, network.hosts);
    return [
      [
        make({
          src: network.gateway.ip,
          dst: victim.ip,
          srcPort: null,
          dstPort: null,
          proto: "ARP",
          flags: "",
          len: 42,
          info: `${network.gateway.ip} is at ${attacker} (duplicate use of ${network.gateway.ip} detected)`,
          anomaly: "spoof",
        }),
      ],
      [
        make({
          src: network.gateway.ip,
          dst: "255.255.255.255",
          srcPort: null,
          dstPort: null,
          proto: "ARP",
          flags: "",
          len: 42,
          info: `Gratuitous ARP for ${network.gateway.ip} (Reply) — was ${network.gateway.mac}, now ${attacker}`,
          anomaly: "spoof",
        }),
      ],
      [
        make({
          src: victim.ip,
          dst: network.gateway.ip,
          srcPort: int(rand, 49152, 65535),
          dstPort: 443,
          proto: "TCP",
          flags: "ACK",
          len: 66,
          info: `Default gateway MAC changed mid-session`,
          anomaly: "spoof",
        }),
      ],
    ];
  }

  /**
   * SYN flood. The tell: a wall of half-open connections to climbing ports,
   * with retransmissions piling up behind them.
   */
  function disrupt(): RawPacket[][] {
    const target = pick(rand, network.hosts);
    const source = `${int(rand, 11, 223)}.${int(rand, 0, 255)}.${int(rand, 0, 255)}.${int(rand, 1, 254)}`;
    const bursts: RawPacket[][] = [];
    let port = int(rand, 1024, 4096);
    let retransChance = 0;

    for (let b = 0; b < 4; b++) {
      const burst: RawPacket[] = [];
      for (let i = 0; i < 5; i++) {
        port += int(rand, 1, 3);
        burst.push(
          make({
            src: source,
            dst: target.ip,
            srcPort: int(rand, 1024, 65535),
            dstPort: port,
            proto: "TCP",
            flags: "SYN",
            len: 60,
            // Retransmissions thicken as the flood wears on, which is the
            // second tell after the raw connection rate.
            info:
              rand() < retransChance
                ? `[TCP Retransmission] Seq=0 Win=1024 Len=0`
                : `Seq=0 Win=1024 Len=0 MSS=1460`,
            anomaly: "disrupt",
          }),
        );
      }
      retransChance += 0.22;
      bursts.push(burst);
    }
    return bursts;
  }

  /**
   * Session hijack. The tell: an established conversation abruptly changes
   * port and protocol, and the TCP sequence jumps far beyond where it was.
   */
  function takeover(victimLabel?: string): RawPacket[][] {
    const victim =
      network.hosts.find((h) => h.label === victimLabel) ?? pick(rand, network.hosts);
    const ext = pick(rand, network.externals);
    const key = `${victim.ip}:${ext.ip}`;
    const before = tcpSeq.get(key) ?? int(rand, 1000, 900000);
    const jumped = before + int(rand, 900000, 4000000);
    tcpSeq.set(key, jumped);

    return [
      [
        make({
          src: victim.ip,
          dst: ext.ip,
          srcPort: 49712,
          dstPort: 4444,
          proto: "TCP",
          flags: "PSH,ACK",
          len: 214,
          info: `Seq=${jumped} (previous Seq=${before}) — sequence jump`,
          anomaly: "takeover",
        }),
      ],
      [
        make({
          src: ext.ip,
          dst: victim.ip,
          srcPort: 4444,
          dstPort: 49712,
          proto: "TELNET",
          flags: "PSH,ACK",
          len: 97,
          info: `Session switched TLS -> TELNET on established stream`,
          anomaly: "takeover",
        }),
      ],
      [
        make({
          src: victim.ip,
          dst: ext.ip,
          srcPort: 49712,
          dstPort: 4444,
          proto: "TELNET",
          flags: "PSH,ACK",
          len: 143,
          info: `Data: cmd.exe /c whoami`,
          anomaly: "takeover",
        }),
      ],
    ];
  }

  return {
    network,
    inject(kind, victimLabel) {
      const bursts =
        kind === "spoof" ? spoof() : kind === "disrupt" ? disrupt() : takeover(victimLabel);
      queued.push(...bursts);
    },
    tick() {
      const out: RawPacket[] = [];
      const n = Math.max(1, baseRate + int(rand, -1, 1));
      for (let i = 0; i < n; i++) out.push(normal());

      // Attack packets ride along with ordinary traffic rather than arriving as
      // an obvious isolated block. Splice, do not append.
      const burst = queued.shift();
      if (burst) {
        for (const p of burst) {
          out.splice(int(rand, 0, out.length), 0, p);
        }
      }

      // Number and stamp in final display order.
      const t = Date.now();
      for (const p of out) {
        p.seq = seq++;
        p.t = t;
      }
      return out;
    },
  };
}

/** Strip ground truth. Anything sent to a player must go through this. */
export function sanitize(p: RawPacket): Packet {
  const { anomaly: _drop, ...rest } = p;
  return rest;
}
