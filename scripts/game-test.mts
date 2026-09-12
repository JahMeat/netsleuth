/**
 * End-to-end check of a round, spoken straight to the room server over raw
 * WebSocket. No browser and no React, so nothing here can be fooled by UI that
 * merely *hides* things.
 *
 * Run the party server first, with a quick sweep:
 *   npx partykit dev --var SCAN_MS=1200
 */
import type { Packet, ServerMessage, Task } from "../lib/protocol";

const ROOM = process.argv[2] ?? `T${Date.now().toString(36).slice(-5).toUpperCase()}`;
const URL = `ws://127.0.0.1:1999/parties/main/${ROOM}`;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Snap = Extract<ServerMessage, { type: "snapshot" }>["room"];

interface Client {
  name: string;
  ws: WebSocket;
  got: ServerMessage[];
  send: (m: unknown) => void;
  of: <T extends ServerMessage["type"]>(t: T) => Extract<ServerMessage, { type: T }>[];
  tasks: () => Task[];
  snap: () => Snap | undefined;
  ip: () => string | undefined;
  packets: () => Packet[];
}

async function connect(name: string): Promise<Client> {
  const ws = new WebSocket(`${URL}?_pk=${name}`);
  await new Promise((res) => ws.addEventListener("open", res, { once: true }));

  const got: ServerMessage[] = [];
  // Latest-state is tracked separately from the buffer, because tests clear the
  // buffer between phases and would otherwise lose the current state.
  let lastTasks: Task[] = [];
  let lastSnap: Snap | undefined;
  let myIp: string | undefined;

  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data as string) as ServerMessage;
    got.push(m);
    if (m.type === "tasks") lastTasks = m.tasks;
    if (m.type === "snapshot") lastSnap = m.room;
    if (m.type === "whoami") myIp = m.ip;
  });

  const of = ((t: string) => got.filter((m) => m.type === t)) as Client["of"];
  return {
    name,
    ws,
    got,
    send: (m) => ws.send(JSON.stringify(m)),
    of,
    tasks: () => lastTasks,
    snap: () => lastSnap,
    ip: () => myIp,
    packets: () => of("packets").flatMap((m) => m.packets),
  };
}

const settle = (ms = 450) => new Promise((r) => setTimeout(r, ms));

async function finishAll(c: Client) {
  for (let guard = 0; guard < 400; guard++) {
    const open = c.tasks().find((t) => t.done < t.steps);
    if (!open) return;
    c.send({ type: "work", taskId: open.id });
    await settle(140);
  }
}

console.log(`\nRoom ${ROOM}\n`);

const alice = await connect("alice");
alice.send({ type: "hello", intent: "create", name: "alice" });
const bob = await connect("bob");
bob.send({ type: "hello", intent: "join", name: "bob" });
const carol = await connect("carol");
carol.send({ type: "hello", intent: "join", name: "carol" });
const dave = await connect("dave");
dave.send({ type: "hello", intent: "join", name: "dave" });
await settle();

const all = [alice, bob, carol, dave];

// --- addresses are private ------------------------------------------------
const ips = all.map((c) => c.ip());
check("everyone is told their own address", ips.every(Boolean), ips.join(" "));
check("addresses are unique", new Set(ips).size === ips.length);

const snapJson = JSON.stringify(alice.snap());
check(
  "NO ADDRESS APPEARS IN THE BROADCAST SNAPSHOT",
  ips.every((ip) => !snapJson.includes(ip!)),
);
check(
  "you are told your own address and nobody else's",
  alice.of("whoami").length === 1 && alice.of("whoami")[0].ip === alice.ip(),
);

// --- roles and tasks ------------------------------------------------------
alice.send({ type: "startGame" });
await settle();

const roles = new Map(all.map((c) => [c.name, c.of("role").at(-1)?.role]));
console.log("roles:", [...roles].map(([n, r]) => `${n}=${r}`).join(" "));
const hacker = all.find((c) => roles.get(c.name) === "hacker")!;
const analysts = all.filter((c) => roles.get(c.name) === "benign");

check("exactly one hacker", analysts.length === 3);
check("no role leaks into the snapshot", !JSON.stringify(alice.snap()).includes("hacker"));
check("the hacker gets tasks too", hacker.tasks().length === analysts[0].tasks().length);

const startTotal = alice.snap()!.progress.total;

// --- the wire is players only --------------------------------------------
for (const c of all) c.got.length = 0;
const watcher = analysts[0];
const t0 = hacker.tasks().find((t) => t.done < t.steps)!;
hacker.send({ type: "work", taskId: t0.id });
await settle();

check("hacker work does not move the bar", alice.snap()!.progress.done === 0);
const fromHacker = watcher.packets().filter((p) => p.src === hacker.ip());
check(
  "hacker's fake work still puts packets on the wire",
  fromHacker.length > 0,
  `${fromHacker.length} from ${hacker.ip()}`,
);
check("HACKER RECEIVES NO FEED", hacker.of("packets").length === 0);

const legit = new Set([...ips, alice.snap()!.gatewayIp, "255.255.255.255"]);
const strangers = watcher.packets().filter((p) => !legit.has(p.src));
check(
  "EVERY SOURCE IS A PLAYER OR THE GATEWAY",
  strangers.length === 0,
  strangers.map((p) => p.src).join(" "),
);

// --- compromising requires recon -----------------------------------------
for (const c of all) c.got.length = 0;
const victim = analysts[analysts.length - 1];
hacker.send({ type: "compromise", ip: victim.ip()! });
await settle();
check(
  "CANNOT COMPROMISE AN ADDRESS YOU HAVE NOT FOUND",
  hacker.of("error").at(-1)?.code === "unknown_ip",
);
check(
  "the victim is still in play",
  alice.snap()!.players.find((p) => p.id === victim.name)?.out === false,
);

watcher.send({ type: "scan", playerId: victim.name });
await settle();
check("analysts cannot sweep", watcher.of("error").at(-1)?.code === "not_hacker");

// --- the sweep ------------------------------------------------------------
for (const c of all) c.got.length = 0;
hacker.send({ type: "scan", playerId: victim.name });
// Poll rather than guess: the sweep delay is configurable, so a fixed wait
// would make this test pass or fail on a server flag instead of on behaviour.
for (let i = 0; i < 40 && hacker.of("scanResult").length === 0; i++) await settle(300);

const result = hacker.of("scanResult").at(-1);
check("sweep returns the address", result?.ip === victim.ip(), String(result?.ip));
check("sweep names who it found", result?.name === victim.name);

const scanTraffic = watcher
  .packets()
  .filter((p) => p.src === hacker.ip() && /sweep|discovery/.test(p.info));
check(
  "THE SWEEP IS VISIBLE ON THE WIRE",
  scanTraffic.length > 0,
  `${scanTraffic.length} packets`,
);
check(
  "the sweep probes more than just the real target",
  new Set(scanTraffic.map((p) => p.dst)).size > 1,
);

// --- the kill -------------------------------------------------------------
for (const c of all) c.got.length = 0;
hacker.send({ type: "compromise", ip: victim.ip()! });
await settle(700);

const afterKill = alice.snap()!;
const victimRow = afterKill.players.find((p) => p.id === victim.name);
check("COMPROMISE TAKES THE PLAYER OUT", victimRow?.out === true);
check("marked as compromised, not voted", victimRow?.outReason === "compromised");
check("the victim is told", victim.of("compromised").length === 1);
check(
  "their unfinished work leaves the total",
  afterKill.progress.total < startTotal,
  `${startTotal} -> ${afterKill.progress.total}`,
);
check("the round continues", afterKill.phase === "playing");

victim.send({ type: "work", taskId: victim.tasks()[0].id });
await settle();
check(
  "a compromised player cannot work",
  alice.snap()!.progress.done === afterKill.progress.done,
);
victim.send({ type: "callMeeting" });
await settle();
check(
  "a compromised player cannot call a meeting",
  victim.of("error").at(-1)?.code === "out",
);

// --- analysts still win by finishing -------------------------------------
for (const a of analysts) {
  if (a === victim) continue;
  await finishAll(a);
}
await settle(800);

const fin = alice.snap()!;
check("round ended", fin.phase === "ended", fin.phase);
check("analysts win on tasks", fin.result?.benignWin === true, fin.result?.reason);
check("hacker revealed", fin.result?.hackerId === hacker.name);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
