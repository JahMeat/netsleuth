"use client";

import { useEffect, useRef, useState } from "react";
import {
  ATTACK_LABELS,
  ATTACK_COOLDOWN_MS,
  COMPROMISE_COOLDOWN_MS,
  SCAN_COOLDOWN_MS,
  type AttackKind,
  type ClientMessage,
  type EndReason,
  type Packet,
  type Player,
  type Role,
  type RoomSnapshot,
  type Task,
} from "@/lib/protocol";
import type { KnownHost } from "@/lib/useRoom";
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

/** Ticks once a second so cooldown labels stay honest. */
function useTick(ms = 250) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

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

/**
 * Who is in the room — names only.
 *
 * Addresses are deliberately absent. You are shown your own and nobody else's,
 * so pinning a packet on a person is an argument to be had out loud rather than
 * a lookup anyone can do silently.
 */
function Roster({
  players,
  youId,
  myIp,
  gatewayIp,
  known,
}: {
  players: Player[];
  youId: string | null;
  myIp: string | null;
  gatewayIp: string;
  /** Hacker only: addresses already swept, shown inline once found. */
  known?: KnownHost[];
}) {
  return (
    <div className="panel">
      <h2>In the room</h2>
      <ul className="playerList compact">
        {players.map((p) => {
          const found = known?.find((k) => k.playerId === p.id);
          return (
            <li
              key={p.id}
              className={p.id === youId ? "you" : p.out ? "gone" : undefined}
            >
              <span className="dot" />
              <span className="pname">{p.name}</span>
              {p.id === youId && <span className="badge">you</span>}
              {p.out && <span className="badge">{p.outReason}</span>}
              {p.id === youId && myIp && <span className="ipTag">{myIp}</span>}
              {found && p.id !== youId && <span className="ipTag found">{found.ip}</span>}
            </li>
          );
        })}
      </ul>
      <p className="hint">
        Gateway is <code>{gatewayIp}</code>. You only know your own address —
        everyone else&apos;s has to be argued out from what the wire shows.
      </p>
    </div>
  );
}

function FeedTable({
  packets,
  flags,
  myIp,
  canFlag,
  send,
}: {
  packets: Packet[];
  flags: Map<number, boolean>;
  myIp: string | null;
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

  return (
    <>
      <div className="feedHead">
        <span className="c-seq">#</span>
        <span className="c-who">mine</span>
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
            Nothing on the wire. Nobody has done anything yet.
          </p>
        ) : (
          packets.map((p) => {
            const flagged = flags.get(p.seq);
            const mine = myIp !== null && p.src === myIp;
            return (
              <div
                key={p.seq}
                className={`prow ${flagged === true ? "hit" : flagged === false ? "miss" : ""} ${mine ? "own" : ""}`}
              >
                <span className="c-seq">{p.seq}</span>
                <span className="c-who">{mine ? "you" : ""}</span>
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
 * Heads-down on your tasks moves the bar but blinds you; watching the wire
 * catches the hacker but leaves your own address silent, which is exactly what
 * a hacker looks like.
 */
export function AnalystScreen({
  room,
  youId,
  myIp,
  packets,
  flags,
  tasks,
  out,
  send,
}: {
  room: RoomSnapshot;
  youId: string | null;
  myIp: string | null;
  packets: Packet[];
  flags: Map<number, boolean>;
  tasks: Task[];
  out: boolean;
  send: (m: ClientMessage) => void;
}) {
  const stalled = room.stalledUntil !== null && room.stalledUntil > Date.now();

  return (
    <div className="gameGrid">
      <div className="gameLeft">
        {out ? (
          <div className="panel">
            <h2>Out</h2>
            <p className="subtitle" style={{ margin: 0 }}>
              You can still read the wire, but you cannot work, flag, or vote.
            </p>
          </div>
        ) : (
          <TaskPanel
            tasks={tasks}
            stalled={stalled}
            onWork={(taskId) => send({ type: "work", taskId })}
          />
        )}
        <Roster
          players={room.players}
          youId={youId}
          myIp={myIp}
          gatewayIp={room.gatewayIp}
        />
      </div>

      <div className="gameRight">
        <FeedTable
          packets={packets}
          flags={flags}
          myIp={myIp}
          canFlag={!out}
          send={send}
        />
      </div>
    </div>
  );
}

/**
 * The Hacker screen. Same task panel as everyone else — theirs advances and
 * completes, it simply never reaches the shared bar — plus recon and the kill.
 *
 * What is absent is the feed: the server never sends it to this connection, so
 * the hacker cannot see the trail they are leaving.
 */
export function HackerScreen({
  room,
  youId,
  myIp,
  tasks,
  known,
  scanning,
  out,
  error,
  send,
}: {
  room: RoomSnapshot;
  youId: string | null;
  myIp: string | null;
  tasks: Task[];
  known: KnownHost[];
  scanning: boolean;
  out: boolean;
  error: { code: string; message: string } | null;
  send: (m: ClientMessage) => void;
}) {
  useTick();
  const [firedAt, setFiredAt] = useState<Partial<Record<AttackKind, number>>>({});
  const [scannedAt, setScannedAt] = useState(0);
  const [killedAt, setKilledAt] = useState(0);
  const [armed, setArmed] = useState<string | null>(null);

  const now = Date.now();
  const stalled = room.stalledUntil !== null && room.stalledUntil > Date.now();
  const scanLeft = Math.ceil((SCAN_COOLDOWN_MS - (now - scannedAt)) / 1000);
  const killLeft = Math.ceil((COMPROMISE_COOLDOWN_MS - (now - killedAt)) / 1000);
  const scanCooling = now - scannedAt < SCAN_COOLDOWN_MS;
  const killCooling = now - killedAt < COMPROMISE_COOLDOWN_MS;

  const targets = room.players.filter((p) => !p.out && p.id !== youId);
  const liveKnown = known.filter((k) =>
    room.players.some((p) => p.id === k.playerId && !p.out),
  );

  return (
    <div className="gameGrid">
      <div className="gameLeft">
        {out ? (
          <div className="panel">
            <h2>Out</h2>
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
          <h2>Your cover</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Your address is <code>{myIp ?? "…"}</code>, and{" "}
            <strong>everything you do comes from it</strong> — fake work, sweeps,
            attacks, kills alike. There is no background traffic to hide in, so
            doing tasks is the only thing that makes you look like everyone else.
          </p>
        </div>
        <Roster
          players={room.players}
          youId={youId}
          myIp={myIp}
          gatewayIp={room.gatewayIp}
          known={known}
        />
      </div>

      <div className="gameRight">
        {error &&
          (error.code === "on_cooldown" ||
            error.code === "unknown_ip" ||
            error.code === "scanning") && <div className="error">{error.message}</div>}

        <div className="panel">
          <h2>Sweep for an address</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            You cannot compromise someone until you know where they are. A sweep
            is slow and unmistakable on the wire — they will see it happen, they
            just will not know it was you.
          </p>
          <div className="targetGrid">
            {targets.map((p) => {
              const found = known.find((k) => k.playerId === p.id);
              return (
                <button
                  key={p.id}
                  className={`targetChip ${found ? "found" : ""}`}
                  disabled={out || scanning || scanCooling || Boolean(found)}
                  onClick={() => {
                    send({ type: "scan", playerId: p.id });
                    setScannedAt(Date.now());
                  }}
                >
                  {p.name}
                  {found ? ` · ${found.ip}` : ""}
                </button>
              );
            })}
          </div>
          <p className="hint">
            {scanning
              ? "Sweep running…"
              : scanCooling
                ? `Sweep recharging ${scanLeft}s`
                : "Ready."}
          </p>
        </div>

        <div className="panel">
          <h2>Compromise</h2>
          {liveKnown.length === 0 ? (
            <p className="subtitle" style={{ margin: 0 }}>
              No addresses found yet. Sweep for one first.
            </p>
          ) : (
            <div className="targetGrid">
              {liveKnown.map((k) => (
                <button
                  key={k.ip}
                  className={`targetChip kill ${armed === k.ip ? "armed" : ""}`}
                  disabled={out || killCooling}
                  onClick={() => {
                    if (armed === k.ip) {
                      send({ type: "compromise", ip: k.ip });
                      setKilledAt(Date.now());
                      setArmed(null);
                    } else {
                      setArmed(k.ip);
                    }
                  }}
                  onBlur={() => armed === k.ip && setArmed(null)}
                >
                  {armed === k.ip ? `confirm — take ${k.name}` : `${k.name} · ${k.ip}`}
                </button>
              ))}
            </div>
          )}
          <p className="hint">
            {killCooling ? `Too hot — wait ${killLeft}s` : "Ready."} A compromised
            account is out of the round for good.
          </p>
        </div>

        <div className="attackGrid">
          {(Object.keys(ATTACK_LABELS) as AttackKind[]).map((kind) => {
            const since = now - (firedAt[kind] ?? -Infinity);
            const cooling = since < ATTACK_COOLDOWN_MS;
            const left = Math.ceil((ATTACK_COOLDOWN_MS - since) / 1000);
            return (
              <button
                key={kind}
                className="attackCard"
                disabled={cooling || out}
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
            If that reaches 100% they win. Taking analysts out shrinks it — their
            unfinished work leaves the total — and gets you to a room you control.
          </p>
        </div>
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
  myIp,
  role,
  send,
}: {
  room: RoomSnapshot;
  youId: string | null;
  myIp: string | null;
  role: Role | null;
  send: (m: ClientMessage) => void;
}) {
  const me = room.players.find((p) => p.id === youId);
  const spectating = me?.out ?? false;
  const myVote = room.votes.find((v) => v.voterId === youId);
  const voted = myVote !== undefined;
  const inPlay = room.players.filter((p) => !p.out);

  const countFor = (id: string | null) =>
    room.votes.filter((v) => v.targetId === id).length;

  return (
    <>
      <div className="gameBar">
        <div>
          <span className="roleTag meeting">Meeting</span>
          <span className="barHint">
            {room.meetingCalledBy ? `Called by ${room.meetingCalledBy}.` : ""}{" "}
            {role === "hacker"
              ? "Someone will ask whose address that was."
              : "Whose address was doing that?"}
          </span>
        </div>
        <div className="barRight">
          <span className="barStat">
            {room.votes.length}/{inPlay.length} voted
          </span>
          <Countdown deadline={room.deadline} />
        </div>
      </div>

      {myIp && (
        <div className="panel" style={{ paddingTop: 14, paddingBottom: 14 }}>
          <p className="hint" style={{ margin: 0 }}>
            Your address is <code>{myIp}</code>. Nobody else can see that — claim
            it or don&apos;t.
          </p>
        </div>
      )}

      <div className="panel">
        <h2>Evidence ({room.evidence.length})</h2>
        {room.evidence.length === 0 ? (
          <p className="subtitle" style={{ margin: 0 }}>
            Nobody flagged anything. Argue from who was quiet instead.
          </p>
        ) : (
          <div className="evidence">
            {room.evidence.map((e, i) => (
              <div
                key={`${e.seq}-${e.byId}-${i}`}
                className={`erow ${e.hit ? "hit" : "miss"}`}
              >
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
              ? "You are out. No vote."
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

  const compromised = room.players.filter((p) => p.outReason === "compromised");

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
          {r.attacksLaunched} attack{r.attacksLaunched === 1 ? "" : "s"} launched
          {compromised.length > 0
            ? ` · ${compromised.map((p) => p.name).join(", ")} compromised`
            : " · nobody compromised"}
          .
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
