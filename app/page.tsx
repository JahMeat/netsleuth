"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Lobby from "@/components/Lobby";
import { generateRoomCode, sanitizeRoomCode, ROOM_CODE_LENGTH } from "@/lib/roomCode";
import { MAX_NAME_LENGTH, normalizeName } from "@/lib/protocol";
import { markCreated, storeName } from "@/lib/session";

/**
 * The entire app is this one page.
 *
 * A room is `/?code=ABC123` rather than its own path. Two reasons: a dynamic
 * path segment cannot be statically exported (room codes are random, so there
 * is no list to prerender), and a static host maps extensionless paths
 * inconsistently — `/room/` serves while `/room` 404s. Collapsing to one route
 * means no pasted link can land on a page that does not exist.
 */
export default function Home() {
  // useSearchParams needs a Suspense boundary to prerender.
  return (
    <Suspense fallback={null}>
      <Entry />
    </Suspense>
  );
}

function Entry() {
  const code = sanitizeRoomCode(useSearchParams().get("code") ?? "");
  return code ? <Lobby code={code} /> : <Landing />;
}

function Landing() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  const validName = normalizeName(name) !== null;
  const validCode = code.length === ROOM_CODE_LENGTH;

  function enter(target: string, creating: boolean) {
    const clean = normalizeName(name);
    if (!clean) return;
    storeName(clean);
    if (creating) markCreated(target);
    router.push(`/?code=${target}`);
  }

  return (
    <main className="shell">
      <div className="brand">
        <h1>Netsleuth</h1>
        <span className="tag">// find the hacker</span>
      </div>
      <p className="subtitle">
        Everyone has an address and a list of tasks. Doing your work puts packets
        on the wire; sitting still leaves a hole where your traffic should be. One
        of you cannot do the work at all.
      </p>

      <div className="panel">
        <h2>Identify yourself</h2>
        <label htmlFor="name">Display name</label>
        <input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={MAX_NAME_LENGTH}
          placeholder="analyst_01"
          autoComplete="off"
        />
      </div>

      <div className="panel">
        <h2>Open a lobby</h2>
        <button disabled={!validName} onClick={() => enter(generateRoomCode(), true)}>
          Create lobby →
        </button>
        <p className="hint">
          You become the host, which means you can start the round and manage the
          lobby.
        </p>

        <div className="divider">OR</div>

        <h2>Join a lobby</h2>
        <div className="row">
          <div className="grow">
            <label htmlFor="code">Room code</label>
            <input
              id="code"
              className="code"
              value={code}
              onChange={(e) => setCode(sanitizeRoomCode(e.target.value))}
              placeholder="●●●●●●"
              autoComplete="off"
              inputMode="text"
              onKeyDown={(e) => {
                if (e.key === "Enter" && validName && validCode) enter(code, false);
              }}
            />
          </div>
          <button
            className="secondary"
            disabled={!validName || !validCode}
            onClick={() => enter(code, false)}
          >
            Join
          </button>
        </div>
      </div>
    </main>
  );
}
