# NETSLEUTH

Social deduction on a live packet feed. One player is secretly the **Hacker**;
everyone else is an **Analyst** watching a simplified Wireshark-style feed,
trying to spot the anomalies the Hacker injects. Flag evidence, then vote.

## Architecture

```
Next.js (Vercel)                 PartyKit room (one room == one lobby)
┌─────────────────┐              ┌──────────────────────────────────┐
│ host browser    │ ──packets──▶ │  authoritative room state        │
│ analyst browsers│ ◀─filtered── │  players / roles / feed / votes  │
│ hacker browser  │ ──attacks──▶ │  (in-memory, no database)        │
└─────────────────┘              └──────────────────────────────────┘
```

Two rules carry the whole game, and both are enforced in `party/main.ts`:

1. **Roles never appear on a snapshot.** Snapshots are broadcast to everyone, so
   a `role` field on one would hand the Hacker away in devtools. Roles are sent
   per-connection instead.
2. **The Hacker is never sent the feed.** The host's browser generates traffic,
   but the *server* decides who receives it. There is no client-side branch to
   flip, because the packets do not arrive at that connection at all.

The Hacker's attacks are relayed back to the host's generator as an anonymous
`inject` message — the host learns an attack happened, never who ordered it.

## Round flow

| Phase | What happens |
| --- | --- |
| `lobby` | Join by code. Host can kick, transfer host, and start at 3+ players. |
| `playing` | Host generates traffic; analysts read and flag it; Hacker fires attacks. |
| `meeting` | Flagged evidence is revealed, marked hit or clean. Everyone votes. |
| `ended` | Hacker revealed, ejection resolved, per-analyst hit/miss scoreboard. |

Attack signatures, all in `lib/packets.ts`:

- **Spoofing** — gateway IP answers from a second MAC; gratuitous ARP; duplicate-address warning.
- **Disruption** — SYN flood across climbing ports, retransmissions thickening as it runs.
- **Takeover** — a live session jumps TCP sequence, switches port and protocol, and the victim's screen is seized for a few seconds.

## Layout

| Path | What it is |
| --- | --- |
| `lib/protocol.ts` | **Wire protocol.** Shared by client and server; the one source of truth. |
| `lib/packets.ts` | Traffic generator + the three attack signatures. Pure, no deps. |
| `lib/useRoom.ts` | One socket, mirrors server state, runs the host's generator loop. |
| `party/main.ts` | Room server — roles, phases, feed filtering, flags, votes. |
| `components/Lobby.tsx` | Lobby + phase routing. |
| `components/Game.tsx` | Monitor, hacker panel, takeover overlay, meeting, results. |

## Running locally

```bash
npm install
npm run dev
```

Next on :3000, PartyKit on :1999. Open <http://localhost:3000>, create a lobby,
then open the room URL in two more tabs. Identity is per-tab, so three tabs are
three players.

Shorter rounds while testing:

```bash
npm run dev:party:fast
```

## Checking it without a browser

```bash
npm run test:feed   # print generated traffic, with anomalies marked
npm run test:game   # drive a full round over raw WebSocket
```

`test:game` is the one that matters: it talks straight to the room server, so it
cannot be fooled by UI that merely hides things. It asserts the Hacker receives
zero packet messages, that ground truth is stripped before sending, and that
roles never appear in a broadcast snapshot.

## Deploying

```bash
npx partykit login     # once
npm run deploy:party   # -> netsleuth.<your-partykit-username>.partykit.dev
```

Then set `NEXT_PUBLIC_PARTYKIT_HOST` to that host in the Vercel project's
environment variables and deploy the Next app. See `.env.example`.

## Tuning

Round and meeting length are PartyKit vars, so they can change without a code
edit — useful during playtesting:

```bash
npx partykit dev --var ROUND_MS=90000 --var MEETING_MS=45000
```

Everything else lives as constants in `lib/protocol.ts` (attack cooldowns,
takeover duration, feed window) and `lib/useRoom.ts` (`TICK_MS`, how fast
traffic arrives).

## Build milestones

- [x] **1.** Scaffold, room-join flow end to end
- [x] **2.** Lobby: kick, transfer host, leave
- [x] **2b.** Start-game gate (host only, minimum 3 players)
- [x] **3.** Role assignment, routing to Analyst vs Hacker screens
- [x] **4.** Packet generator with 3 attack signatures
- [x] **5.** Host generates feed -> server -> analysts only
- [x] **6.** Hacker control panel
- [x] **7.** Flagging, round timer, vote + tally + results
- [ ] **8.** Multi-device playtest, tune anomaly frequency/subtlety

## Known rough edges

- Room state is in-memory. If every player disconnects, the lobby is gone (the
  "this code exists" marker is persisted, so the code still works).
- A host whose connection actually drops loses the host role permanently, and
  with it the job of generating the feed. A reconnect grace period would fix it.
- The host's browser holds ground truth for the traffic it generates, so a host
  who is also an analyst could read anomalies out of devtools. The server never
  sends ground truth to anyone, but the generator runs client-side by design.
- Players can still join a room whose round has started; they arrive with no
  role and see an analyst screen with an empty feed.
- A kick bars the player's tab id for the room's lifetime. Someone who clears
  sessionStorage gets a fresh id and can rejoin.
- No rematch button yet — the `ended` phase is terminal until everyone leaves.
