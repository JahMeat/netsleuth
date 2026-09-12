/**
 * Checks that the claims the README makes to players are actually true.
 *
 * The manual is the first thing a new player reads, so a number that drifts out
 * of date there is worse than one in a code comment: it teaches the wrong game.
 * Everything asserted here is quoted from README.md.
 *
 * Constants are checked against the source of truth; behaviour is checked by
 * talking to a running room server.
 *
 *   npm run dev:party   # in another terminal
 *   npm run test:readme
 */
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
  type ServerMessage,
  type Task,
} from "../lib/protocol";
import { createTaskList } from "../lib/tasks";
import {
  activityPackets,
  compromisePackets,
  disruptPackets,
  scanPackets,
  spoofPackets,
  takeoverPackets,
} from "../lib/packets";
import { readFileSync } from "node:fs";

let failures = 0;
function check(claim: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${claim}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Whitespace-normalised, because markdown wraps prose and a claim that happens
// to straddle a line break is still the same claim.
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
  .replace(/\s+/g, " ");

/** The README must actually contain the phrase it is being held to. */
function quoted(phrase: string): boolean {
  return readme.includes(phrase.replace(/\s+/g, " "));
}

console.log("\n--- numbers the manual quotes ---\n");

check('"at least 3 players"', quoted("at least 3 players") && MIN_PLAYERS === 3);
check('"4 tasks"', quoted("**4 tasks**") && TASKS_PER_PLAYER === 4);
check('"A round is 5 minutes"', quoted("**5 minutes**") && ROUND_MS === 300_000);
check('"75 seconds" of meeting', quoted("**75 seconds**") && MEETING_MS === 75_000);
check('sweep "6 seconds" to return', quoted("**6 seconds**") && SCAN_MS === 6_000);
check('sweep "20-second" cooldown', quoted("**20-second**") && SCAN_COOLDOWN_MS === 20_000);
check('"35 seconds" between kills', quoted("**35 seconds**") && COMPROMISE_COOLDOWN_MS === 35_000);
check('attacks "25 seconds each"', quoted("25 seconds each") && ATTACK_COOLDOWN_MS === 25_000);
check(
  'attacks "10 seconds between any two"',
  quoted("10 seconds between any two") && GLOBAL_ATTACK_COOLDOWN_MS === 10_000,
);
check('disruption freezes "8 seconds"', quoted("8 seconds") && STALL_MS === 8_000);
check('takeover blacks out "6 seconds"', quoted("6 seconds") && TAKEOVER_MS === 6_000);

console.log("\n--- what the tasks actually are ---\n");

const list = createTaskList(Math.random, TASKS_PER_PLAYER);
check("a player gets exactly 4 tasks", list.length === 4, `${list.length}`);
const click = list.find((t) => t.kind === "click");
const wind = list.find((t) => t.kind === "wind");
check('"clear six alerts"', quoted("clear six alerts") && click?.steps === 6, `${click?.steps}`);
check('"wind a handle ten times"', quoted("wind a handle ten times") && wind?.steps === 10, `${wind?.steps}`);
check(
  "every task kind the manual names is dealt",
  new Set(list.map((t) => t.kind)).size === 3,
  [...new Set(list.map((t) => t.kind))].join(","),
);

console.log("\n--- the feed lines the manual prints ---\n");

const ctx = { from: "10.0.0.37", gatewayIp: "10.0.0.1", seqFrom: 0 };
const lines = [
  ...activityPackets({ ...ctx, kind: "type" }),
  ...activityPackets({ ...ctx, kind: "click" }),
  ...activityPackets({ ...ctx, kind: "wind" }),
  ...scanPackets({ ...ctx, targets: ["10.0.0.61"] }),
  ...compromisePackets({ ...ctx, victim: "10.0.0.61" }),
  ...spoofPackets(ctx),
  ...disruptPackets(ctx),
  ...takeoverPackets({ ...ctx, victim: "10.0.0.61" }),
];
const infos = lines.map((p) => p.info);
const shows = (fragment: string) =>
  quoted(fragment) && infos.some((i) => i.includes(fragment));

check("POST /api/notes keystroke batch", shows("POST /api/notes keystroke batch"));
check("POST /api/actions/ack", shows("POST /api/actions/ack"));
check("WebSocket frame: relay.step", shows("WebSocket frame: relay.step"));
check("(address sweep)", shows("(address sweep)"));
check("host discovery", shows("host discovery"));
check("replayed session key", shows("replayed session key"));
check("locked out", shows("locked out"));
check("duplicate use of", shows("duplicate use of"));
check("default gateway MAC changed mid-session", shows("default gateway MAC changed mid-session"));
check("Seq=0 Win=1024 Len=0 MSS=1460", shows("Seq=0 Win=1024 Len=0 MSS=1460"));
check("[TCP Retransmission]", shows("[TCP Retransmission]"));
check("sequence jump", shows("sequence jump"));
check("Session switched TLS -> TELNET", shows("Session switched TLS -> TELNET"));

check(
  '"ten of them" in the flood',
  quoted("ten of them") && disruptPackets(ctx).length === 10,
  `${disruptPackets(ctx).length}`,
);
check(
  "every hostile line comes from one address",
  [...scanPackets({ ...ctx, targets: ["10.0.0.61"] }), ...spoofPackets(ctx), ...disruptPackets(ctx)]
    .every((p) => p.src === ctx.from),
);

console.log("\n--- behaviour, against a live room server ---\n");

const ROOM = `A${Date.now().toString(36).slice(-5).toUpperCase()}`;
const WS_URL = `ws://127.0.0.1:1999/parties/main/${ROOM}`;

async function connect(name: string) {
  const ws = new WebSocket(`${WS_URL}?_pk=${name}`);
  await new Promise((res) => ws.addEventListener("open", res, { once: true }));
  const got: ServerMessage[] = [];
  let snap: Extract<ServerMessage, { type: "snapshot" }>["room"] | undefined;
  let tasks: Task[] = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data as string) as ServerMessage;
    got.push(m);
    if (m.type === "snapshot") snap = m.room;
    if (m.type === "tasks") tasks = m.tasks;
  });
  return {
    name,
    ws,
    got,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    of: (t: string) => got.filter((x) => x.type === t),
    snap: () => snap,
    tasks: () => tasks,
  };
}
const settle = (ms = 450) => new Promise((r) => setTimeout(r, ms));

const a = await connect("alice");
a.send({ type: "hello", intent: "create", name: "alice" });
const b = await connect("bob");
b.send({ type: "hello", intent: "join", name: "bob" });
const c = await connect("carol");
c.send({ type: "hello", intent: "join", name: "carol" });
await settle();

check(
  '"the host starts the round" — others cannot',
  (() => {
    b.send({ type: "startGame" });
    return true;
  })(),
);
await settle();
check(
  "a non-host start is refused",
  (b.of("error").at(-1) as Extract<ServerMessage, { type: "error" }>)?.code === "not_host",
);

a.send({ type: "startGame" });
await settle();
const all = [a, b, c];
const hacker = all.find(
  (x) => (x.of("role").at(-1) as Extract<ServerMessage, { type: "role" }>)?.role === "hacker",
)!;

check('"Everyone gets 4 tasks" — the hacker too', hacker.tasks().length === TASKS_PER_PLAYER);
check(
  '"Anyone can call one meeting" — including the hacker',
  (() => {
    hacker.send({ type: "callMeeting" });
    return true;
  })(),
);
await settle();
check("the hacker's meeting opened", a.snap()?.phase === "meeting");
check(
  '"A tie throws nobody out"',
  (() => {
    const [x, y, z] = all;
    x.send({ type: "vote", targetId: y.name });
    y.send({ type: "vote", targetId: x.name });
    z.send({ type: "vote", targetId: null });
    return true;
  })(),
);
await settle(900);
check(
  "nobody was ejected on a tie",
  (a.snap()?.players ?? []).every((p) => !p.out),
  (a.snap()?.players ?? []).filter((p) => p.out).map((p) => p.name).join(",") || "none",
);
check('"one meeting per round" is now spent', a.snap()?.players.find((p) => p.id === hacker.name)?.canCallMeeting === false);
check("the round resumed after the vote", a.snap()?.phase === "playing");

// The manual's newest claim: a hacker who quits forfeits.
// Watch from someone who survives — the hacker may be `a`, and a closed socket
// receives no further snapshots.
const survivor = all.find((x) => x !== hacker)!;
hacker.ws.close();
await settle(1200);
const fin = survivor.snap();
check(
  '"If the hacker disconnects ... the analysts take it"',
  fin?.result?.benignWin === true,
  `${fin?.phase ?? "no snapshot"} / ${fin?.result?.reason ?? "no result"}`,
);

console.log(`\n${failures === 0 ? "README MATCHES THE GAME" : `${failures} CLAIM(S) DO NOT MATCH`}\n`);
process.exit(failures === 0 ? 0 : 1);
