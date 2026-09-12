/**
 * Checks that a restart leaves nothing of the previous round behind — in
 * particular that addresses are re-drawn, so knowledge from round one is
 * worthless in round two.
 *
 * Ends round one by voting the hacker out rather than waiting for the clock,
 * so the test does not depend on how the server was launched.
 */
import type { ServerMessage, Task } from "../lib/protocol";

const ROOM = `R${Date.now().toString(36).slice(-5).toUpperCase()}`;
const URL = `ws://127.0.0.1:1999/parties/main/${ROOM}`;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Snap = Extract<ServerMessage, { type: "snapshot" }>["room"];

async function connect(name: string) {
  const ws = new WebSocket(`${URL}?_pk=${name}`);
  await new Promise((res) => ws.addEventListener("open", res, { once: true }));
  const got: ServerMessage[] = [];
  let snap: Snap | undefined;
  let ip: string | undefined;
  let tasks: Task[] = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data as string) as ServerMessage;
    got.push(m);
    if (m.type === "snapshot") snap = m.room;
    if (m.type === "whoami") ip = m.ip;
    if (m.type === "tasks") tasks = m.tasks;
  });
  return {
    name,
    got,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    of: (t: string) => got.filter((x) => x.type === t),
    snap: () => snap,
    ip: () => ip,
    tasks: () => tasks,
  };
}

const settle = (ms = 450) => new Promise((r) => setTimeout(r, ms));

console.log(`\nRoom ${ROOM}\n`);

const a = await connect("alice");
a.send({ type: "hello", intent: "create", name: "alice" });
const b = await connect("bob");
b.send({ type: "hello", intent: "join", name: "bob" });
const c = await connect("carol");
c.send({ type: "hello", intent: "join", name: "carol" });
await settle();

const all = [a, b, c];
const ips1 = all.map((x) => x.ip()!);

a.send({ type: "startGame" });
await settle();
const roles1 = all.map((x) => x.of("role").at(-1) as Extract<ServerMessage, { type: "role" }>);
check("round 1 started", a.snap()?.phase === "playing");

// Leave some state behind to be cleared: a spent meeting, and some work done.
const t = a.tasks().find((x) => x.done < x.steps);
if (t) a.send({ type: "work", taskId: t.id });
await settle();

// End round 1 deterministically by voting the hacker out, rather than waiting
// on ROUND_MS — that would make this pass or fail on how the server was
// launched instead of on restart behaviour.
const hackerName = all.find(
  (x) => (x.of("role").at(-1) as Extract<ServerMessage, { type: "role" }>)?.role === "hacker",
)!.name;
b.send({ type: "callMeeting" });
await settle();
for (const x of all) x.send({ type: "vote", targetId: hackerName });
for (let i = 0; i < 20 && a.snap()?.phase !== "ended"; i++) await settle(300);
check("round 1 ended", a.snap()?.phase === "ended", a.snap()?.phase);
check("ended by catching the hacker", a.snap()?.result?.reason === "hacker_ejected");
check("there is a result", a.snap()?.result != null);

// A non-host cannot restart.
b.send({ type: "restart" });
await settle();
const lastErr = b.of("error").at(-1) as Extract<ServerMessage, { type: "error" }> | undefined;
check("only the host can restart", lastErr?.code === "not_host");

for (const x of all) x.got.length = 0;
a.send({ type: "restart" });
await settle(700);

const s2 = a.snap()!;
check("BACK IN THE LOBBY", s2.phase === "lobby");
check("result cleared", s2.result === null);
check("evidence cleared", s2.evidence.length === 0);
check("votes cleared", s2.votes.length === 0);
check("progress reset", s2.progress.done === 0);
check("no deadline", s2.deadline === null);
check("meetings restored", s2.players.every((p) => p.canCallMeeting));
check("nobody is out", s2.players.every((p) => !p.out && p.outReason === null));

const ips2 = all.map((x) => x.ip()!);
check("everyone got a new address message", all.every((x) => x.of("whoami").length === 1));
check(
  "ADDRESSES ARE RE-DRAWN",
  ips2.every((ip, i) => ip !== ips1[i]),
  `${ips1.join(",")} -> ${ips2.join(",")}`,
);
check("new addresses are unique", new Set(ips2).size === ips2.length);

// Round 2 must be playable, with roles redrawn independently.
a.send({ type: "startGame" });
await settle();
check("round 2 starts", a.snap()?.phase === "playing");
const roles2 = all.map((x) => x.of("role").at(-1) as Extract<ServerMessage, { type: "role" }>);
check("roles reissued", roles2.every((r) => r?.role === "benign" || r?.role === "hacker"));
check(
  "exactly one hacker again",
  roles2.filter((r) => r?.role === "hacker").length === 1,
);
check("tasks reissued", all.every((x) => x.tasks().every((t) => t.done === 0)));
console.log(
  `  ..  round 1 roles ${roles1.map((r) => r?.role).join(",")} / round 2 ${roles2.map((r) => r?.role).join(",")}`,
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
