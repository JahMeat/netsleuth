/**
 * End-to-end check of a round, spoken straight to the room server over raw
 * WebSocket. No browser and no React, so nothing here can be fooled by UI that
 * merely *hides* things.
 *
 * Run the party server first, with a short round:
 *   npm run dev:party -- --var ROUND_MS=8000 --var MEETING_MS=15000
 */
import type { ServerMessage, Task } from "../lib/protocol";

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
  tasks: () => Task[];
  snap: () => Extract<ServerMessage, { type: "snapshot" }>["room"] | undefined;
}

async function connect(name: string): Promise<Client> {
  const ws = new WebSocket(`${URL}?_pk=${name}`);
  await new Promise((res) => ws.addEventListener("open", res, { once: true }));

  const got: ServerMessage[] = [];
  // Latest-state is tracked separately from the buffer, because tests clear the
  // buffer between phases and would otherwise lose the current tasks/snapshot.
  let lastTasks: Task[] = [];
  let lastSnap: Extract<ServerMessage, { type: "snapshot" }>["room"] | undefined;

  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data as string) as ServerMessage;
    got.push(m);
    if (m.type === "tasks") lastTasks = m.tasks;
    if (m.type === "snapshot") lastSnap = m.room;
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
  };
}

const settle = (ms = 450) => new Promise((r) => setTimeout(r, ms));

/** Grind a task list to completion, respecting the server's work rate limit. */
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
// Four, not three: with three players one ejection leaves a single analyst
// against the hacker, which is parity and ends the round immediately. Four is
// the smallest game where a wrong vote is survivable.
const dave = await connect("dave");
dave.send({ type: "hello", intent: "join", name: "dave" });
await settle();

const all = [alice, bob, carol, dave];

// --- addresses ------------------------------------------------------------
const lobby = alice.snap()!;
const ips = lobby.players.map((p) => p.ip);
check("every player has an IP", ips.every(Boolean), ips.join(" "));
check("IPs are unique", new Set(ips).size === ips.length);
check(
  "players sit below the ambient range",
  ips.every((ip) => Number(ip.split(".")[3]) < 100),
  ips.join(" "),
);

// --- roles and tasks ------------------------------------------------------
alice.send({ type: "startGame" });
await settle();

const roles = new Map(all.map((c) => [c.name, c.of("role").at(-1)?.role]));
console.log("roles:", [...roles].map(([n, r]) => `${n}=${r}`).join(" "));
const hacker = all.find((c) => roles.get(c.name) === "hacker")!;
const analysts = all.filter((c) => roles.get(c.name) === "benign");

check("exactly one hacker", analysts.length === all.length - 1);
check("no role leaks into the snapshot", !JSON.stringify(alice.snap()).includes("hacker"));
check("everyone gets a task list", all.every((c) => c.tasks().length > 0));
check(
  "THE HACKER GETS TASKS TOO",
  hacker.tasks().length === analysts[0].tasks().length,
  `hacker=${hacker.tasks().length} analyst=${analysts[0].tasks().length}`,
);

const startProgress = alice.snap()!.progress;
check(
  "bar counts analysts only",
  startProgress.total > 0 &&
    startProgress.total ===
      analysts.reduce((n, c) => n + c.tasks().reduce((m, t) => m + t.steps, 0), 0),
  `total=${startProgress.total}`,
);

// --- work emits traffic, but only analysts move the bar -------------------
for (const c of all) c.got.length = 0;

const hackerTask = hacker.tasks().find((t) => t.done < t.steps)!;
hacker.send({ type: "work", taskId: hackerTask.id });
await settle();

const afterHackerWork = alice.snap()!.progress;
check(
  "HACKER WORK DOES NOT MOVE THE BAR",
  afterHackerWork.done === startProgress.done,
  `${startProgress.done} -> ${afterHackerWork.done}`,
);
check(
  "hacker's own task list still advances",
  (hacker.tasks().find((t) => t.id === hackerTask.id)?.done ?? 0) > 0,
);

const hackerIp = alice.snap()!.players.find((p) => p.id === hacker.name)?.ip;
const seenFromHacker = analysts[0]
  .of("packets")
  .flatMap((m) => m.packets)
  .filter((p) => p.src === hackerIp);
check(
  "hacker's fake work still puts packets on the wire",
  seenFromHacker.length > 0,
  `${seenFromHacker.length} packets from ${hackerIp}`,
);
check("HACKER STILL RECEIVES NO FEED", hacker.of("packets").length === 0);

for (const c of all) c.got.length = 0;
const aTask = analysts[0].tasks().find((t) => t.done < t.steps)!;
analysts[0].send({ type: "work", taskId: aTask.id });
await settle();
check(
  "analyst work moves the bar",
  (alice.snap()?.progress.done ?? 0) > afterHackerWork.done,
);

// --- disruption stalls work ----------------------------------------------
for (const c of all) c.got.length = 0;
hacker.send({ type: "attack", kind: "disrupt" });
await settle();
check("disruption sets a stall", (alice.snap()?.stalledUntil ?? 0) > Date.now());

const before = alice.snap()!.progress.done;
const t2 = analysts[0].tasks().find((t) => t.done < t.steps)!;
analysts[0].send({ type: "work", taskId: t2.id });
await settle();
check("work is refused while stalled", analysts[0].of("error").at(-1)?.code === "stalled");
check("bar did not move while stalled", alice.snap()!.progress.done === before);

// --- meetings are player-called ------------------------------------------
for (const c of all) c.got.length = 0;
await settle(8200); // let the stall lapse

analysts[0].send({ type: "callMeeting" });
await settle();
check("a player can call a meeting", alice.snap()?.phase === "meeting");
check(
  "the meeting names its caller",
  typeof alice.snap()?.meetingCalledBy === "string",
  String(alice.snap()?.meetingCalledBy),
);

analysts[0].send({ type: "callMeeting" });
await settle();
check(
  "only one meeting each",
  analysts[0].of("error").at(-1)?.code === "no_meeting_left" ||
    analysts[0].of("error").at(-1)?.code === "wrong_phase",
);

// Vote out an analyst: with three analysts left, the round must continue.
const scapegoat = analysts[analysts.length - 1];
for (const c of all) c.send({ type: "vote", targetId: scapegoat.name });
await settle(700);

const afterVote = alice.snap()!;
check("wrong ejection does not end the round", afterVote.phase === "playing");
check(
  "the ejected player is marked",
  afterVote.players.find((p) => p.id === scapegoat.name)?.ejected === true,
);
check(
  "their unfinished work leaves the total",
  afterVote.progress.total < startProgress.total,
  `${startProgress.total} -> ${afterVote.progress.total}`,
);

scapegoat.send({ type: "work", taskId: scapegoat.tasks()[0].id });
await settle();
check("ejected players cannot work", alice.snap()!.progress.done === afterVote.progress.done);

// --- analysts win by finishing the work ----------------------------------
// Everyone still in play has to finish; the ejected analyst's work already
// left the denominator.
for (const a of analysts) {
  if (a === scapegoat) continue;
  await finishAll(a);
}
await settle(800);

const fin = alice.snap()!;
check("round ended", fin.phase === "ended", fin.phase);
check("ANALYSTS WIN ON TASKS", fin.result?.benignWin === true, fin.result?.reason);
check("reason is tasks_complete", fin.result?.reason === "tasks_complete");
check("hacker revealed", fin.result?.hackerId === hacker.name);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
