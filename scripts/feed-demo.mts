/**
 * Print what each kind of traffic looks like, without a server or a browser.
 *
 * Useful for tuning how obvious the hostile signatures are: everything an
 * analyst ever sees is built by one of these functions.
 */
import {
  activityPackets,
  compromisePackets,
  disruptPackets,
  scanPackets,
  spoofPackets,
  takeoverPackets,
  sanitize,
  type RawPacket,
} from "../lib/packets";

let s = 12345;
const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);

const GATEWAY = "192.168.7.1";
const ME = "192.168.7.34";
const VICTIM = "192.168.7.61";
const OTHERS = ["192.168.7.22", "192.168.7.61", "192.168.7.88"];

let seq = 0;
const pad = (v: string | number | null, n: number) => String(v ?? "-").padEnd(n);

function show(label: string, packets: RawPacket[]) {
  console.log(`\n=== ${label} ===`);
  for (const p of packets) {
    const mark = p.anomaly ? `<< ${p.anomaly.toUpperCase()}` : "";
    console.log(
      `${pad(p.seq, 4)} ${pad(p.src, 16)} -> ${pad(p.dst, 16)} ${pad(p.proto, 7)} ${pad(p.flags, 8)} ${p.info.slice(0, 58).padEnd(58)} ${mark}`,
    );
  }
  seq += packets.length;
}

const ctx = () => ({ from: ME, gatewayIp: GATEWAY, seqFrom: seq, rand });

show("ordinary work: typing", activityPackets({ ...ctx(), kind: "type" }));
show("ordinary work: clicking", activityPackets({ ...ctx(), kind: "click" }));
show("ordinary work: winding", activityPackets({ ...ctx(), kind: "wind" }));

show("recon sweep", scanPackets({ ...ctx(), targets: OTHERS }));
show("compromise", compromisePackets({ ...ctx(), victim: VICTIM }));
show("attack: spoof", spoofPackets(ctx()));
show("attack: disrupt", disruptPackets(ctx()));
show("attack: takeover", takeoverPackets({ ...ctx(), victim: VICTIM }));

const probe = spoofPackets(ctx())[0];
console.log(
  "\nsanitize() drops ground truth:",
  !("anomaly" in sanitize(probe)),
);
console.log("every source is a player or the gateway: by construction — no host list exists.\n");
