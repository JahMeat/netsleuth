"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const { status, room, youId, error, kickedBy, hasLeft, leave, rejoin, send } = useRoom({
    code,
    name,
    intent,
  });

  /** Which row has its overflow menu open. At most one at a time. */
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const closeMenu = useCallback(() => setOpenMenu(null), []);

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

  if (hasLeft) {
    return (
      <Shell>
        <div className="panel">
          <h2>Left lobby</h2>
          <p className="subtitle" style={{ margin: 0 }}>
            You left <strong>{code}</strong>. Rejoin with the same code if you were not
            done.
          </p>
        </div>
        <div className="row">
          <button onClick={rejoin}>Rejoin {code}</button>
          <Link href="/">
            <button className="secondary">Back to start</button>
          </Link>
        </div>
      </Shell>
    );
  }

  // A code nobody created is a dead end, not a lobby that might fill up. Show
  // the error alone rather than pairing it with an empty, hopeful player list.
  const fatal = error?.code === "room_not_found";
  const youAreHost = room?.players.some((p) => p.id === youId && p.isHost) ?? false;

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
                {room.players.map((p) => (
                  <PlayerRow
                    key={p.id}
                    player={p}
                    isYou={p.id === youId}
                    showMenu={youAreHost && p.id !== youId}
                    menuOpen={openMenu === p.id}
                    onToggleMenu={() =>
                      setOpenMenu((cur) => (cur === p.id ? null : p.id))
                    }
                    onCloseMenu={closeMenu}
                    onMakeHost={() => {
                      send({ type: "transferHost", playerId: p.id });
                      closeMenu();
                    }}
                    onKick={() => {
                      send({ type: "kick", playerId: p.id });
                      closeMenu();
                    }}
                  />
                ))}
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
                    You are the host: your browser will generate the packet feed. The{" "}
                    <strong>&middot;&middot;&middot;</strong> menu on a player lets you
                    hand off that job or remove them.
                  </>
                ) : (
                  <>
                    You are the host. Once someone else joins, a{" "}
                    <strong>&middot;&middot;&middot;</strong> menu on their row lets you
                    hand off the host role or remove them.
                  </>
                )}
              </p>
            )}
          </div>

          <div className="lobbyFoot">
            <div className="status">
              <span
                className={`dot ${
                  status === "connected"
                    ? ""
                    : status === "closed"
                      ? "closed"
                      : "connecting"
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
            <button className="secondary" onClick={leave}>
              Leave lobby
            </button>
          </div>
        </>
      )}
    </Shell>
  );
}

function PlayerRow({
  player,
  isYou,
  showMenu,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onMakeHost,
  onKick,
}: {
  player: Player;
  isYou: boolean;
  showMenu: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onMakeHost: () => void;
  onKick: () => void;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  // Kicking is not undoable, so the item arms on first click, commits on second.
  const [kickArmed, setKickArmed] = useState(false);

  // Reset arming whenever the menu closes, so reopening never starts hot.
  useEffect(() => {
    if (!menuOpen) setKickArmed(false);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;

    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) onCloseMenu();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseMenu();
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, onCloseMenu]);

  return (
    <li className={isYou ? "you" : undefined}>
      <span className="dot" />
      <span className="pname">{player.name}</span>
      {isYou && <span className="badge">you</span>}
      {player.isHost && <span className="badge host">host</span>}

      {showMenu && (
        <span className="menuWrap" ref={wrapRef}>
          <button
            className="dots"
            onClick={onToggleMenu}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Actions for ${player.name}`}
            title={`Actions for ${player.name}`}
          >
            &middot;&middot;&middot;
          </button>

          {menuOpen && (
            <span className="menu" role="menu">
              <button role="menuitem" onClick={onMakeHost}>
                Make host
              </button>
              <button
                role="menuitem"
                className={`danger ${kickArmed ? "armed" : ""}`}
                onClick={() => (kickArmed ? onKick() : setKickArmed(true))}
              >
                {kickArmed ? "Confirm kick" : "Kick from lobby"}
              </button>
            </span>
          )}
        </span>
      )}
    </li>
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
