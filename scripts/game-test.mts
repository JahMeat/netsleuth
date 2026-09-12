/**
 * End-to-end check of the round, spoken straight to the room server over raw
 * WebSocket. No browser and no React, so nothing here can be fooled by UI that
 * merely *hides* things — if the Hacker can receive the feed, this will see it.
 *
 * Run the party server first:  npm run dev:party
 */
import { createFeed } from "../lib/packets";
import type { ServerMessage } from "../lib/protocol";

const ROOM = process.argv[2] ?? `T${Date.now().toString(36).slice(-5).toUpperCase()}`;
const URL = `ws://127.0.0.1:1999/parties/main/${ROOM}`;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

interface Client {
  name: string;
  ws: WebSocket;
  got: ServerMessage[];
  send: (m: unknown) => void;
  of: <T extends ServerMessage["type"]>(t: T) => Extract<ServerMessage, { type: T }>[];
}

async function connect(name: string): Promise<Client> {
  const ws = new WebSocket(`${URL}?_pk=${name}`);
  await new Promise((res) => ws.addEventListener("open", res, { once: true }));
  const got: ServerMessage[] = [];
  ws.addEventListener("message", (e) => got.push(JSON.parse(e.data as string)));
  return {
    name,
    ws,
    got,
    send: (m) => ws.send(JSON.stringify(m)),
    of: (t) => got.filter((m) => m.type === t) as never,
  };
}

const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

console.log(`\nRoom ${ROOM}\n`);

const alice = await connect("alice");
alice.send({ type: "hello", intent: "create", name: "alice" });
const bob = await connect("bob");
bob.send({ type: "hello", intent: "join", name: "bob" });
const carol = await connect("carol");
carol.send({ type: "hello", intent: "join", name: "carol" });
await settle();

const all = [alice, bob, carol];

// --- roles ----------------------------------------------------------------
alice.send({ type: "startGame" });
await settle();

const roles = new Map(all.map((c) => [c.name, c.of("role").at(-1)?.role]));
console.log("roles:", [...roles].map(([n, r]) => `${n}=${r}`).join(" "));

const hackers = all.filter((c) => roles.get(c.name) === "hacker");
const benign = all.filter((c) => roles.get(c.name) === "benign");
check("exactly one hacker", hackers.length === 1, `got ${hackers.length}`);
check("everyone else benign", benign.length === 2, `got ${benign.length}`);

const snap = alice.of("snapshot").at(-1);
check("phase is playing", snap?.room.phase === "playing", snap?.room.phase);
check(
  "no role leaks into the broadcast snapshot",
  !JSON.stringify(snap?.room).includes("hacker"),
);
check("round has a deadline", typeof snap?.room.deadline === "number");

// --- the feed, and who is allowed to see it -------------------------------
const hacker = hackers[0];
for (const c of all) c.got.length = 0;

let s = 99;
const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
const feed = createFeed({ rand });
feed.inject("spoof");

const batches = [feed.tick(), feed.tick(), feed.tick()];
for (const b of batches) alice.send({ type: "feed", packets: b });
await settle();

const sent = batches.flat();
const anomalySeqs = sent.filter((p) => p.anomaly).map((p) => p.seq);
const cleanSeqs = sent.filter((p) => !p.anomaly).map((p) => p.seq);
check("generator produced anomalies to test with", anomalySeqs.length > 0);

const benignGot = benign.map((c) => c.of("packets").flatMap((m) => m.packets));
check("benign players receive the feed", benignGot.every((ps) => ps.length === sent.length));
check(
  "HACKER RECEIVES NOTHING",
  hacker.of("packets").length === 0,
  `${hacker.of("packets").length} packet messages`,
);
check(
  "ground truth is stripped before sending",
  !benignGot.flat().some((p) => "anomaly" in p),
);

// --- attacks --------------------------------------------------------------
for (const c of all) c.got.length = 0;
hacker.send({ type: "attack", kind: "disrupt" });
await settle();

check("host is told to inject", alice.of("inject").at(-1)?.kind === "disrupt");
check(
  "inject message does not name the hacker",
  !JSON.stringify(alice.of("inject").at(-1) ?? {}).includes(hacker.name),
);

hacker.send({ type: "attack", kind: "disrupt" });
await settle();
check("same attack is rate limited", hacker.of("error").at(-1)?.code === "on_cooldown");

const notHacker = benign[0];
notHacker.send({ type: "attack", kind: "spoof" });
await settle();
check("benign player cannot attack", notHacker.of("error").at(-1)?.code === "not_hacker");

// --- flagging -------------------------------------------------------------
for (const c of all) c.got.length = 0;
const flagger = benign[0];
flagger.send({ type: "flag", seq: anomalySeqs[0] });
flagger.send({ type: "flag", seq: cleanSeqs[0] });
await settle();

const acks = flagger.of("flagAck");
check("flagging an anomaly scores a hit", acks.find((a) => a.seq === anomalySeqs[0])?.hit === true);
check("flagging clean traffic is a miss", acks.find((a) => a.seq === cleanSeqs[0])?.hit === false);

hacker.send({ type: "flag", seq: anomalySeqs[0] });
await settle();
check("hacker cannot flag", hacker.of("error").at(-1)?.code === "bad_message");

const midSnap = flagger.of("snapshot").at(-1);
check(
  "evidence stays hidden during the round",
  (midSnap?.room.evidence.length ?? 0) === 0,
);

// --- voting ---------------------------------------------------------------
// Only reached when ROUND_MS is patched low for the test run.
const waited = await Promise.race([
  (async () => {
    for (let i = 0; i < 40; i++) {
      await settle(500);
      if (alice.of("snapshot").at(-1)?.room.phase === "meeting") return true;
    }
    return false;
  })(),
]);

if (!waited) {
  console.log("\n(meeting not reached — ROUND_MS is the full length; run with a short round to test voting)");
} else {
  const m = alice.of("snapshot").at(-1)!;
  check("evidence revealed in meeting", m.room.evidence.length > 0);
  check("evidence marks which flags were real", m.room.evidence.some((e) => e.hit));

  for (const c of all) c.send({ type: "vote", targetId: hacker.name });
  await settle(800);

  const fin = alice.of("snapshot").at(-1)!;
  check("round ended", fin.room.phase === "ended");
  check("hacker revealed correctly", fin.room.result?.hackerId === hacker.name);
  check("ejecting the hacker is an analyst win", fin.room.result?.benignWin === true);
  check("scoreboard lists analysts", (fin.room.result?.hits.length ?? 0) === 2);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
