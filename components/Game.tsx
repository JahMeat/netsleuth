"use client";

import { useEffect, useRef, useState } from "react";
import {
  ATTACK_LABELS,
  ATTACK_COOLDOWN_MS,
  type AttackKind,
  type ClientMessage,
  type Packet,
  type Role,
  type RoomSnapshot,
} from "@/lib/protocol";

/** Live countdown to a server-set deadline. */
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
  const urgent = left < 30000;

  return (
    <span className={`clock ${urgent ? "urgent" : ""}`}>
      {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

/**
 * The Benign screen: a live packet list you can flag.
 *
 * The list is deliberately plain text in a monospace grid. Anomalies are not
 * marked in any way — spotting them is the entire game, and the client is not
 * told which packets are real attacks until the meeting.
 */
export function BenignMonitor({
  room,
  packets,
  flags,
  send,
}: {
  room: RoomSnapshot;
  packets: Packet[];
  flags: Map<number, boolean>;
  send: (m: ClientMessage) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  // Autoscroll, but yield the moment the analyst scrolls up to study something.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !follow) return;
    el.scrollTop = el.scrollHeight;
  }, [packets, follow]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setFollow(atBottom);
  }

  const hits = [...flags.values()].filter(Boolean).length;

  return (
    <>
      <div className="gameBar">
        <div>
          <span className="roleTag benign">Analyst</span>
          <span className="barHint">Flag anything that should not be on this wire.</span>
        </div>
        <div className="barRight">
          <span className="barStat">
            {flags.size} flagged · {hits} confirmed
          </span>
          <Countdown deadline={room.deadline} />
        </div>
      </div>

      <div className="feedHead">
        <span className="c-seq">#</span>
        <span className="c-src">source</span>
        <span className="c-dst">destination</span>
        <span className="c-proto">proto</span>
        <span className="c-port">sport</span>
        <span className="c-port">dport</span>
        <span className="c-flags">flags</span>
        <span className="c-len">len</span>
        <span className="c-info">info</span>
        <span className="c-act" />
      </div>

      <div className="feed" ref={scrollRef} onScroll={onScroll}>
        {packets.length === 0 ? (
          <p className="subtitle" style={{ padding: 16 }}>
            Waiting for traffic from the host&hellip;
          </p>
        ) : (
          packets.map((p) => {
            const flagged = flags.get(p.seq);
            return (
              <div
                key={p.seq}
                className={`prow ${flagged === true ? "hit" : flagged === false ? "miss" : ""}`}
              >
                <span className="c-seq">{p.seq}</span>
                <span className="c-src">{p.src}</span>
                <span className="c-dst">{p.dst}</span>
                <span className="c-proto">{p.proto}</span>
                <span className="c-port">{p.srcPort ?? "—"}</span>
                <span className="c-port">{p.dstPort ?? "—"}</span>
                <span className="c-flags">{p.flags || "—"}</span>
                <span className="c-len">{p.len}</span>
                <span className="c-info">{p.info}</span>
                <span className="c-act">
                  {flagged === undefined ? (
                    <button
                      className="flagBtn"
                      onClick={() => send({ type: "flag", seq: p.seq })}
                    >
                      flag
                    </button>
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
 * The Hacker screen. Note what is *not* here: the packet feed. The server never
 * sends it to this connection, so there is nothing to reveal even in devtools.
 */
export function HackerPanel({
  room,
  send,
  error,
}: {
  room: RoomSnapshot;
  send: (m: ClientMessage) => void;
  error: { code: string; message: string } | null;
}) {
  // Cooldowns are enforced on the server; this is just so the buttons tell the
  // truth about when they will work again.
  const [firedAt, setFiredAt] = useState<Partial<Record<AttackKind, number>>>({});
  const [, force] = useState(0);

  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();

  return (
    <>
      <div className="gameBar">
        <div>
          <span className="roleTag hacker">Hacker</span>
          <span className="barHint">
            You cannot see the feed. Everyone else can. Time your noise.
          </span>
        </div>
        <div className="barRight">
          <Countdown deadline={room.deadline} />
        </div>
      </div>

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
              disabled={cooling}
              onClick={() => {
                send({ type: "attack", kind });
                setFiredAt((f) => ({ ...f, [kind]: Date.now() }));
              }}
            >
              <span className="attackName">{ATTACK_LABELS[kind].name}</span>
              <span className="attackBlurb">{ATTACK_LABELS[kind].blurb}</span>
              <span className="attackState">
                {cooling ? `recharging ${left}s` : "ready"}
              </span>
            </button>
          );
        })}
      </div>

      <div className="panel">
        <h2>Who is watching</h2>
        <ul className="playerList">
          {room.players.map((p) => (
            <li key={p.id}>
              <span className="dot" />
              <span className="pname">{p.name}</span>
              {p.isHost && <span className="badge host">host</span>}
            </li>
          ))}
        </ul>
        <p className="hint">
          Every one of them is reading the wire. An attack they all notice is an
          attack they can vote on.
        </p>
      </div>
    </>
  );
}

/** The full-screen seizure a takeover inflicts on one analyst. */
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

/** Discussion and the vote. */
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
  const myVote = room.votes.find((v) => v.voterId === youId);
  const voted = myVote !== undefined;

  function countFor(id: string | null) {
    return room.votes.filter((v) => v.targetId === id).length;
  }

  return (
    <>
      <div className="gameBar">
        <div>
          <span className="roleTag meeting">Meeting</span>
          <span className="barHint">
            {role === "hacker"
              ? "Say something reasonable."
              : "Compare evidence. Then vote."}
          </span>
        </div>
        <div className="barRight">
          <span className="barStat">
            {room.votes.length}/{room.players.length} voted
          </span>
          <Countdown deadline={room.deadline} />
        </div>
      </div>

      <div className="panel">
        <h2>Evidence ({room.evidence.length})</h2>
        {room.evidence.length === 0 ? (
          <p className="subtitle" style={{ margin: 0 }}>
            Nobody flagged anything. That is its own kind of evidence.
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
          {room.players.map((p) => {
            const n = countFor(p.id);
            const mine = myVote?.targetId === p.id;
            return (
              <li key={p.id} className={mine ? "you" : undefined}>
                <span className="dot" />
                <span className="pname">{p.name}</span>
                {n > 0 && <span className="badge">{n} vote{n === 1 ? "" : "s"}</span>}
                <button
                  className="voteBtn"
                  disabled={voted}
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
            {voted ? "Vote locked in." : "You get one vote. A tie ejects nobody."}
          </span>
          <button
            className="secondary"
            disabled={voted}
            onClick={() => send({ type: "vote", targetId: null })}
          >
            Skip ({countFor(null)})
          </button>
        </div>
      </div>
    </>
  );
}

/** Who it was, whether the room got them, and who read the wire best. */
export function Results({ room }: { room: RoomSnapshot }) {
  const r = room.result;
  if (!r) return null;

  return (
    <>
      <div className={`verdict ${r.benignWin ? "win" : "lose"}`}>
        <p className="verdictLine">
          {r.benignWin ? "Analysts win" : "Hacker wins"}
        </p>
        <p className="verdictSub">
          The hacker was <strong>{r.hackerName}</strong>.{" "}
          {r.ejectedName
            ? `The room ejected ${r.ejectedName}.`
            : "The room ejected nobody."}
        </p>
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
              <span className="badge host">{h.hits} hit{h.hits === 1 ? "" : "s"}</span>
              <span className="badge">{h.misses} miss{h.misses === 1 ? "" : "es"}</span>
            </li>
          ))}
        </ul>
        {r.hits.length === 0 && (
          <p className="subtitle" style={{ margin: 0 }}>
            No analyst flags to score.
          </p>
        )}
      </div>
    </>
  );
}
