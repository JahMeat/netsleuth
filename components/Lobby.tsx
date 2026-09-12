"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRoom } from "@/lib/useRoom";
import { didCreate, getStoredName, storeName } from "@/lib/session";
import { MAX_NAME_LENGTH, normalizeName, type Player } from "@/lib/protocol";
import { isValidRoomCode } from "@/lib/roomCode";

export default function Lobby({ code }: { code: string }) {
  // Resolved after mount: sessionStorage does not exist during SSR.
  const [name, setName] = useState<string | null>(null);
  const [intent, setIntent] = useState<"create" | "join">("join");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setName(getStoredName());
    setIntent(didCreate(code) ? "create" : "join");
    setReady(true);
  }, [code]);

  if (!isValidRoomCode(code)) {
    return (
      <Shell>
        <div className="error">
          <strong>{code || "(empty)"}</strong> is not a valid room code.
        </div>
        <Link href="/">&larr; Back to start</Link>
      </Shell>
    );
  }

  if (!ready) return <Shell><p className="subtitle">Loading&hellip;</p></Shell>;

  // Someone opened a shared room link directly, so they never passed through
  // the landing page and have no name yet.
  if (!name) {
    return <NameGate code={code} onSubmit={(n) => { storeName(n); setName(n); }} />;
  }

  return <ConnectedLobby code={code} name={name} intent={intent} />;
}

function ConnectedLobby({
  code,
  name,
  intent,
}: {
  code: string;
  name: string;
  intent: "create" | "join";
}) {
  const { status, room, youId, error, kickedBy, send } = useRoom({ code, name, intent });

  // Which player a host action is awaiting confirmation for. Kicking is not
  // undoable, so it takes two clicks rather than one stray one.
  const [pending, setPending] = useState<{ action: "kick" | "host"; id: string } | null>(null);

  if (kickedBy) {
    return (
      <Shell>
        <div className="error">
          You were removed from lobby <strong>{code}</strong> by {kickedBy}.
        </div>
        <Link href="/">&larr; Back to start</Link>
      </Shell>
    );
  }

  // A code nobody created is a dead end, not a lobby that might fill up. Show
  // the error alone rather than pairing it with an empty, hopeful player list.
  const fatal = error?.code === "room_not_found";
  const youAreHost = room?.players.some((p) => p.id === youId && p.isHost) ?? false;

  function act(action: "kick" | "host", target: Player) {
    if (pending?.action === action && pending.id === target.id) {
      send(
        action === "kick"
          ? { type: "kick", playerId: target.id }
          : { type: "transferHost", playerId: target.id },
      );
      setPending(null);
    } else {
      setPending({ action, id: target.id });
    }
  }

  return (
    <Shell>
      <div className="panel">
        <h2>Room code</h2>
        <p className="codeDisplay">{code}</p>
        {!fatal && (
          <p className="hint">
            Share this code, or send the link to this page. Open it in a second tab to
            test with two players.
          </p>
        )}
      </div>

      {error && !fatal && error.code !== "not_host" && (
        <div className="error">{error.message}</div>
      )}
      {fatal && (
        <div className="error">
          {error.message} <Link href="/">Start a new lobby &rarr;</Link>
        </div>
      )}

      {!fatal && (
        <>
          <div className="panel">
            <h2>Players {room ? `(${room.players.length})` : ""}</h2>
            {room && room.players.length > 0 ? (
              <ul className="playerList">
                {room.players.map((p) => {
                  const isYou = p.id === youId;
                  const pendingKick = pending?.action === "kick" && pending.id === p.id;
                  const pendingHost = pending?.action === "host" && pending.id === p.id;
                  return (
                    <li key={p.id} className={isYou ? "you" : undefined}>
                      <span className="dot" />
                      <span className="pname">{p.name}</span>
                      {isYou && <span className="badge">you</span>}
                      {p.isHost && <span className="badge host">host</span>}

                      {youAreHost && !isYou && (
                        <span className="actions">
                          <button
                            className={`mini ${pendingHost ? "confirm" : ""}`}
                            onClick={() => act("host", p)}
                            onBlur={() => pendingHost && setPending(null)}
                            title={`Make ${p.name} the host`}
                          >
                            {pendingHost ? "confirm?" : "make host"}
                          </button>
                          <button
                            className={`mini danger ${pendingKick ? "confirm" : ""}`}
                            onClick={() => act("kick", p)}
                            onBlur={() => pendingKick && setPending(null)}
                            title={`Remove ${p.name} from the lobby`}
                          >
                            {pendingKick ? "confirm?" : "kick"}
                          </button>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="subtitle" style={{ margin: 0 }}>
                {status === "connected" ? "Waiting for players…" : "Connecting…"}
              </p>
            )}
            {youAreHost && room && (
              <p className="hint">
                {room.players.length > 1 ? (
                  <>
                    You are the host: your browser will generate the packet feed. Use{" "}
                    <strong>make host</strong> to hand that job off, or <strong>kick</strong>{" "}
                    to remove someone.
                  </>
                ) : (
                  // Host controls act on *other* players, so there is nothing to
                  // render while alone. Say so, or the feature reads as missing.
                  <>
                    You are the host. Once someone else joins, you can hand off the host
                    role or remove them from here.
                  </>
                )}
              </p>
            )}
          </div>

          <div className="status">
            <span
              className={`dot ${
                status === "connected" ? "" : status === "closed" ? "closed" : "connecting"
              }`}
            />
            <span>
              {status === "connected"
                ? "Linked to room server"
                : status === "closed"
                  ? "Disconnected — retrying"
                  : "Connecting to room server…"}
            </span>
          </div>
        </>
      )}
    </Shell>
  );
}

function NameGate({
  code,
  onSubmit,
}: {
  code: string;
  onSubmit: (name: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const clean = normalizeName(draft);

  return (
    <Shell>
      <div className="panel">
        <h2>Joining {code}</h2>
        <label htmlFor="name">Display name</label>
        <div className="row">
          <div className="grow">
            <input
              id="name"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={MAX_NAME_LENGTH}
              placeholder="analyst_02"
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === "Enter" && clean) onSubmit(clean);
              }}
            />
          </div>
          <button disabled={!clean} onClick={() => clean && onSubmit(clean)}>
            Enter
          </button>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="shell">
      <div className="brand">
        <h1>Netsleuth</h1>
        <span className="tag">// lobby</span>
      </div>
      {children}
    </main>
  );
}
