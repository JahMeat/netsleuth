# NETSLEUTH

Social deduction on a live packet feed. One player is secretly the **Hacker**;
everyone else is **Benign** and watches a simplified Wireshark-style feed, trying
to spot the anomalies the Hacker injects. Flag evidence, then vote.

## Architecture

```
Next.js (Vercel)                 PartyKit room (one room == one lobby)
┌─────────────────┐              ┌──────────────────────────────────┐
│ host browser    │ ──packets──▶ │  authoritative room state        │
│ benign browsers │ ◀─filtered── │  players / roles / packets/votes │
│ hacker browser  │ ──attacks──▶ │  (in-memory, no database)        │
└─────────────────┘              └──────────────────────────────────┘
```

The host's browser generates the packet feed, but the **server** decides who
receives it. Role-based filtering is server-side in `party/main.ts`, never
merely hidden in the UI — the Hacker's client must not be able to read the feed
off the wire.

## Layout

| Path | What it is |
| --- | --- |
| `app/page.tsx` | Landing: pick a name, create or join a lobby |
| `app/room/[code]/page.tsx` | Room route; normalizes the code |
| `components/Lobby.tsx` | Lobby UI, name gate for direct links |
| `lib/protocol.ts` | **Wire protocol.** Shared by client and server |
| `lib/useRoom.ts` | React hook: one socket, mirrors server state |
| `lib/roomCode.ts` | 6-char codes, unambiguous alphabet |
| `lib/session.ts` | Per-tab identity (sessionStorage) |
| `party/main.ts` | PartyKit room server — the authority |

## Running locally

```bash
npm install
npm run dev          # Next on :3000 and PartyKit on :1999 together
```

Or in separate terminals: `npm run dev:next` / `npm run dev:party`.

Open <http://localhost:3000>, create a lobby, then open the room URL in a second
tab. Identity is per-tab, so two tabs are two players.

## Deploying

```bash
npm run deploy:party   # -> netsleuth.<your-partykit-username>.partykit.dev
```

Then set `NEXT_PUBLIC_PARTYKIT_HOST` to that host in the Vercel project's
environment variables and deploy the Next app. See `.env.example`.

## Build milestones

- [x] **1.** Scaffold, room-join flow end to end
- [ ] **2.** Lobby polish: ready-up, start-game gate
- [ ] **3.** Role assignment, route to Benign monitor vs Hacker panel
- [ ] **4.** Packet generator (pure function, 3 attack signatures)
- [ ] **5.** Host generates feed -> server -> Benign players only
- [ ] **6.** Hacker control panel (spoof / disrupt / takeover)
- [ ] **7.** Flag packets, round timer, vote + tally
- [ ] **8.** Multi-device playtest, tune subtlety

## Known rough edges

- Room state is in-memory. If every player disconnects, the lobby's player list
  is gone (the "this code exists" marker is persisted, so the code still works).
- No max player count or reconnect grace period yet.
