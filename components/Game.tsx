"use client";

import { useEffect, useRef, useState } from "react";
import {
  ATTACK_LABELS,
  ATTACK_COOLDOWN_MS,
  type AttackKind,
  type ClientMessage,
  type EndReason,
  type Packet,
  type Player,
  type Role,
  type RoomSnapshot,
  type Task,
} from "@/lib/protocol";
import { TaskPanel } from "./Tasks";

export function Countdown({ deadline }: { deadline: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  if (deadline === null) return null;
  const left = Math.max(0, deadline - now);
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);

  return (
    <span className={`clock ${left < 30000 ? "urgent" : ""}`}>
      {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

/** The shared task bar. Everyone sees it, including the Hacker. */
export function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="progressWrap" title={`${done} of ${total} work units`}>
      <div className="progressTrack">
        <div className="progressFill" style={{ width: `${pct}%` }} />
      </div>
      <span className="progressPct">{pct}%</span>
    </div>
  );
}

/** Who is on the LAN, and at which address. The core detection aid. */
function Roster({
  players,
  youId,
  gatewayIp,
}: {
  players: Player[];
  youId: string | null;
  gatewayIp: string;
}) {
  return (
    <div className="panel">
      <h2>Hosts on this segment</h2>
      <ul className="playerList compact">
        <li className="gatewayRow">
          <span className="dot" />
          <span className="pname">gateway</span>
          <span className="ipTag">{gatewayIp}</span>
        </li>
        {players.map((p) => (
          <li key={p.id} className={p.id === youId ? "you" : p.ejected ? "gone" : undefined}>
            <span className="dot" />
            <span className="pname">{p.name}</span>
            {p.id === youId && <span className="badge">you</span>}
            {p.ejected && <span className="badge">ejected</span>}
            <span className="ipTag">{p.ip}</span>
          </li>
        ))}
      </ul>
      <p className="hint">
        Every packet carries the address of whoever caused it. Match the quiet
        address to the quiet player.
      </p>
    </div>
  );
}

function FeedTable({
  packets,
  flags,
  players,
  youId,
  canFlag,
  send,
}: {
  packets: Packet[];
  flags: Map<number, boolean>;
  players: Player[];
  youId: string | null;
  canFlag: boolean;
  send: (m: ClientMessage) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !follow) return;
    el.scrollTop = el.scrollHeight;
  }, [packets, follow]);

  // Resolve an address back to a person, so the feed reads socially rather than
  // numerically. This is the whole shift from the Wireshark version.
  const byIp = new Map(players.map((p) => [p.ip, p]));

  return (
    <>
      <div className="feedHead">
        <span className="c-seq">#</span>
        <span className="c-who">who</span>
        <span className="c-src">source</span>
        <span className="c-dst">destination</span>
        <span className="c-proto">proto</span>
        <span className="c-flags">flags</span>
        <span className="c-info">info</span>
        <span className="c-act" />
      </div>

      <div
        className="feed"
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
      >
        {packets.length === 0 ? (
          <p className="subtitle" style={{ padding: 16 }}>
            Quiet on the wire&hellip;
          </p>
        ) : (
          packets.map((p) => {
            const flagged = flags.get(p.seq);
            const who = byIp.get(p.src);
            return (
              <div
                key={p.seq}
                className={`prow ${flagged === true ? "hit" : flagged === false ? "miss" : ""}`}
              >
                <span className="c-seq">{p.seq}</span>
                <span className={`c-who ${who ? "known" : ""}`}>
                  {who ? (who.id === youId ? `${who.name} (you)` : who.name) : "—"}
                </span>
                <span className="c-src">{p.src}</span>
                <span className="c-dst">{p.dst}</span>
                <span className="c-proto">{p.proto}</span>
                <span className="c-flags">{p.flags || "—"}</span>
                <span className="c-info">{p.info}</span>
                <span className="c-act">
                  {flagged === undefined ? (
                    canFlag ? (
                      <button
                        className="flagBtn"
                        onClick={() => send({ type: "flag", seq: p.seq })}
                      >
                        flag
                      </button>
                    ) : null
                  ) : (
                    <span className={`flagMark ${flagged ? "hit" : "miss"}`}>
                      {flagged ? "hit" : "miss"}
                    </span>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>

      {!follow && (
        <button
          className="resume"
          onClick={() => {
            setFollow(true);
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          ↓ Resume live feed
        </button>
      )}
    </>
  );
}

/**
 * The Analyst screen: tasks on one side, the wire on the other.
 *
 * The tension is the layout. Heads-down on your tasks moves the bar but blinds
 * you; watching the feed catches the hacker but leaves your own address silent,
 * which is exactly what a hacker looks like.
 */
export function AnalystScreen({
  room,
  youId,
  packets,
  flags,
  tasks,
  ejected,
  send,
}: {
  room: RoomSnapshot;
  youId: string | null;
  packets: Packet[];
  flags: Map<number, boolean>;
  tasks: Task[];
  ejected: boolean;
  send: (m: ClientMessage) => void;
}) {
  const stalled = room.stalledUntil !== null && room.stalledUntil > Date.now();

  return (
    <div className="gameGrid">
      <div className="gameLeft">
        {ejected ? (
          <div className="panel">
            <h2>Ejected</h2>
            <p className="subtitle" style={{ margin: 0 }}>
              You are out. You can still read the wire, but you cannot work,
              flag, or vote.
            </p>
          </div>
        ) : (
          <TaskPanel
            tasks={tasks}
            stalled={stalled}
            onWork={(taskId) => send({ type: "work", taskId })}
          />
        )}
        <Roster players={room.players} youId={youId} gatewayIp={room.gatewayIp} />
      </div>

      <div className="gameRight">
        <FeedTable
          packets={packets}
          flags={flags}
          players={room.players}
          youId={youId}
          canFlag={!ejected}
          send={send}
        />
      </div>
    </div>
  );
}

/**
 * The Hacker screen. Same task panel as everyone else — theirs advances and
 * completes, it simply never reaches the shared bar — plus the three attacks.
 * What is absent is the feed: the server never sends it to this connection.
 */
export function HackerScreen({
  room,
  youId,
  tasks,
  ejected,
  error,
  send,
}: {
  room: RoomSnapshot;
  youId: string | null;
  tasks: Task[];
  ejected: boolean;
  error: { code: string; message: string } | null;
  send: (m: ClientMessage) => void;
}) {
  const [firedAt, setFiredAt] = useState<Partial<Record<AttackKind, number>>>({});
  const [, force] = useState(0);

  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const stalled = room.stalledUntil !== null && room.stalledUntil > Date.now();

  return (
    <div className="gameGrid">
      <div className="gameLeft">
        {ejected ? (
          <div className="panel">
            <h2>Ejected</h2>
            <p className="subtitle" style={{ margin: 0 }}>
              They got you. Watch it play out.
            </p>
          </div>
        ) : (
          <TaskPanel
            tasks={tasks}
            stalled={stalled}
            onWork={(taskId) => send({ type: "work", taskId })}
          />
        )}
        <div className="panel">
          <h2>Cover</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Your tasks look exactly like theirs on the wire, and they complete on
            your screen — they just never move the shared bar. Working is how you
            stop being the quiet address.
          </p>
        </div>
      </div>

      <div className="gameRight">
        {error && error.code === "on_cooldown" && (
          <div className="error">{error.message}</div>
        )}

        <div className="attackGrid">
          {(Object.keys(ATTACK_LABELS) as AttackKind[]).map((kind) => {
            const since = now - (firedAt[kind] ?? -Infinity);
            const cooling = since < ATTACK_COOLDOWN_MS;
            const left = Math.ceil((ATTACK_COOLDOWN_MS - since) / 1000);
            return (
              <button
                key={kind}
                className="attackCard"
                disabled={cooling || ejected}
                onClick={() => {
                  send({ type: "attack", kind });
                  setFiredAt((f) => ({ ...f, [kind]: Date.now() }));
                }}
              >
                <span className="attackName">{ATTACK_LABELS[kind].name}</span>
                <span className="attackBlurb">{ATTACK_LABELS[kind].blurb}</span>
                <span className="attackEffect">{ATTACK_LABELS[kind].effect}</span>
                <span className="attackState">
                  {cooling ? `recharging ${left}s` : "ready"}
                </span>
              </button>
            );
          })}
        </div>

        <div className="panel">
          <h2>The bar is your clock</h2>
          <ProgressBar done={room.progress.done} total={room.progress.total} />
          <p className="hint">
            If that reaches 100% they win. Disruption is the only thing that
            actually slows it — the others just make noise you can be caught for.
          </p>
        </div>

        <Roster players={room.players} youId={youId} gatewayIp={room.gatewayIp} />
      </div>
    </div>
  );
}

export function TakeoverOverlay({ until }: { until: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);

  const left = Math.max(0, until - now);
  if (left === 0) return null;

  return (
    <div className="takeover" role="alert">
      <div className="takeoverInner">
        <p className="takeoverTag">SESSION HIJACKED</p>
        <p className="takeoverBody">
          Your console is not yours right now. Someone else is driving it.
        </p>
        <p className="takeoverClock">{(left / 1000).toFixed(1)}s</p>
      </div>
    </div>
  );
}

export function Meeting({
  room,
  youId,
  role,
  send,
}: {
  room: RoomSnapshot;
  youId: string | null;
  role: Role | null;
  send: (m: ClientMessage) => void;
}) {
  const me = room.players.find((p) => p.id === youId);
  const spectating = me?.ejected ?? false;
  const myVote = room.votes.find((v) => v.voterId === youId);
  const voted = myVote !== undefined;
  const inPlay = room.players.filter((p) => !p.ejected);

  const countFor = (id: string | null) =>
    room.votes.filter((v) => v.targetId === id).length;

  return (
    <>
      <div className="gameBar">
        <div>
          <span className="roleTag meeting">Meeting</span>
          <span className="barHint">
            {room.meetingCalledBy
              ? `Called by ${room.meetingCalledBy}.`
              : "Compare evidence."}{" "}
            {role === "hacker" ? "Say something reasonable." : "Who went quiet?"}
          </span>
        </div>
        <div className="barRight">
          <span className="barStat">
            {room.votes.length}/{inPlay.length} voted
          </span>
          <Countdown deadline={room.deadline} />
        </div>
      </div>

      <div className="panel">
        <h2>Evidence ({room.evidence.length})</h2>
        {room.evidence.length === 0 ? (
          <p className="subtitle" style={{ margin: 0 }}>
            Nobody flagged anything. Argue from who was quiet instead.
          </p>
        ) : (
          <div className="evidence">
            {room.evidence.map((e, i) => (
              <div key={`${e.seq}-${e.byId}-${i}`} className={`erow ${e.hit ? "hit" : "miss"}`}>
                <span className="ebadge">{e.hit ? e.kind : "clean"}</span>
                <span className="eby">{e.byName}</span>
                <span className="einfo">
                  <code>
                    {e.packet.src} → {e.packet.dst} {e.packet.proto}
                  </code>{" "}
                  {e.packet.info}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Vote</h2>
        <ul className="playerList">
          {inPlay.map((p) => {
            const n = countFor(p.id);
            const mine = myVote?.targetId === p.id;
            return (
              <li key={p.id} className={mine ? "you" : undefined}>
                <span className="dot" />
                <span className="pname">{p.name}</span>
                <span className="ipTag">{p.ip}</span>
                {n > 0 && (
                  <span className="badge">
                    {n} vote{n === 1 ? "" : "s"}
                  </span>
                )}
                <button
                  className="voteBtn"
                  disabled={voted || spectating}
                  onClick={() => send({ type: "vote", targetId: p.id })}
                >
                  {mine ? "voted" : "vote"}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="lobbyFoot" style={{ marginTop: 14 }}>
          <span className="hint" style={{ margin: 0 }}>
            {spectating
              ? "Spectators do not vote."
              : voted
                ? "Vote locked in."
                : "One vote each. A tie ejects nobody."}
          </span>
          <button
            className="secondary"
            disabled={voted || spectating}
            onClick={() => send({ type: "vote", targetId: null })}
          >
            Skip ({countFor(null)})
          </button>
        </div>
      </div>
    </>
  );
}

const REASONS: Record<EndReason, string> = {
  tasks_complete: "Every task was finished.",
  hacker_ejected: "The room voted out the hacker.",
  time_expired: "The clock ran out with work outstanding.",
  analysts_outnumbered: "Too few analysts left to finish the work.",
  hacker_left: "The hacker left the room.",
};

export function Results({ room }: { room: RoomSnapshot }) {
  const r = room.result;
  if (!r) return null;

  return (
    <>
      <div className={`verdict ${r.benignWin ? "win" : "lose"}`}>
        <p className="verdictLine">{r.benignWin ? "Analysts win" : "Hacker wins"}</p>
        <p className="verdictSub">
          {REASONS[r.reason]} The hacker was <strong>{r.hackerName}</strong>.
        </p>
        <div style={{ marginTop: 16, maxWidth: 420 }}>
          <ProgressBar done={r.progress.done} total={r.progress.total} />
        </div>
      </div>

      <div className="panel">
        <h2>Round</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          {r.attacksLaunched} attack{r.attacksLaunched === 1 ? "" : "s"} launched.
        </p>
        <ul className="playerList">
          {r.hits.map((h) => (
            <li key={h.playerId}>
              <span className="dot" />
              <span className="pname">{h.name}</span>
              <span className="badge host">{h.tasksDone} tasks</span>
              <span className="badge">{h.hits} hits</span>
              <span className="badge">{h.misses} misses</span>
            </li>
          ))}
        </ul>
        {r.hits.length === 0 && (
          <p className="subtitle" style={{ margin: 0 }}>
            No analysts to score.
          </p>
        )}
      </div>
    </>
  );
}
