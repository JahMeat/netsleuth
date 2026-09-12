import { createFeed, sanitize, type AttackKind } from "../lib/packets";

// Seeded LCG so runs are reproducible while eyeballing output.
let s = 12345;
const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);

const feed = createFeed({ rand });
const pad = (v: string | number | null, n: number) => String(v ?? "-").padEnd(n);

function show(label: string, ticks: number) {
  console.log(`\n=== ${label} ===`);
  for (let i = 0; i < ticks; i++) {
    for (const p of feed.tick()) {
      const mark = p.anomaly ? `<< ${p.anomaly.toUpperCase()}` : "";
      console.log(
        `${pad(p.seq, 4)} ${pad(p.src, 16)} -> ${pad(p.dst, 16)} ${pad(p.proto, 7)} ${pad(p.srcPort, 6)}${pad(p.dstPort, 7)} ${pad(p.flags, 8)} ${p.info.slice(0, 52).padEnd(52)} ${mark}`,
      );
    }
  }
}

show("baseline traffic", 2);
for (const kind of ["spoof", "disrupt", "takeover"] as AttackKind[]) {
  feed.inject(kind);
  show(`after inject: ${kind}`, 5);
}

const p = feed.tick()[0];
console.log("\nsanitize() drops ground truth:", JSON.stringify(sanitize(p)).includes("anomaly") === false);
