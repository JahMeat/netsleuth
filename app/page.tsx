"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { generateRoomCode, sanitizeRoomCode, ROOM_CODE_LENGTH } from "@/lib/roomCode";
import { MAX_NAME_LENGTH, normalizeName } from "@/lib/protocol";
import { markCreated, storeName } from "@/lib/session";

export default function Home() {
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
    router.push(`/room/${target}`);
  }

  return (
    <main className="shell">
      <div className="brand">
        <h1>Netsleuth</h1>
        <span className="tag">// find the hacker</span>
      </div>
      <p className="subtitle">
        One of you is injecting anomalies into the network. Everyone else is watching
        the wire. Read the packets, flag the evidence, vote them out.
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
        <button
          disabled={!validName}
          onClick={() => enter(generateRoomCode(), true)}
        >
          Create lobby →
        </button>
        <p className="hint">
          You become the host. The host&apos;s browser generates the packet feed.
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
