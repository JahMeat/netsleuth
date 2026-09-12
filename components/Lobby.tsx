"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRoom } from "@/lib/useRoom";
import { didCreate, getStoredName, storeName } from "@/lib/session";
import { MAX_NAME_LENGTH, normalizeName } from "@/lib/protocol";
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
        <Link href="/">← Back to start</Link>
      </Shell>
    );
  }

  if (!ready) return <Shell><p className="subtitle">Loading…</p></Shell>;

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
  const { status, room, youId, error } = useRoom({ code, name, intent });

  // A code nobody created is a dead end, not a lobby that might fill up. Show
  // the error alone rather than pairing it with an empty, hopeful player list.
  const fatal = error?.code === "room_not_found";

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

      {error && (
        <div className="error">
          {error.message}{" "}
          {fatal && <Link href="/">Start a new lobby &rarr;</Link>}
        </div>
      )}

      {!fatal && (
        <>
          <div className="panel">
            <h2>Players {room ? `(${room.players.length})` : ""}</h2>
            {room && room.players.length > 0 ? (
              <ul className="playerList">
                {room.players.map((p) => (
                  <li key={p.id} className={p.id === youId ? "you" : undefined}>
                    <span className="dot" />
                    <span className="pname">{p.name}</span>
                    {p.id === youId && <span className="badge">you</span>}
                    {p.isHost && <span className="badge host">host</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="subtitle" style={{ margin: 0 }}>
                {status === "connected" ? "Waiting for players…" : "Connecting…"}
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
