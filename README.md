# NETSLEUTH

Social deduction where the network traffic *is* the players.

Everyone gets an IP and a list of tasks. Doing a task — typing, clicking,
winding — puts packets on the wire from your own address. One player is secretly
the **Hacker**: they get an identical task list that completes on their screen
but never moves the shared bar, so their only real move is to attack and stall.

Analysts win by finishing every task, or by voting the Hacker out. The Hacker
wins by running out the clock, or by whittling the analysts down to one.

The catch is that the feed is a record of who has been busy. Head-down on your
own tasks moves the bar but blinds you; watching the wire catches the Hacker but
leaves *your* address quiet — which is exactly what a Hacker looks like.

## Architecture

```
Next.js (Vercel)                 PartyKit room (one room == one lobby)
┌─────────────────┐              ┌──────────────────────────────────┐
│ host browser    │ ──packets──▶ │  authoritative room state        │
│ analyst browsers│ ◀─filtered── │  players / roles / feed / votes  │
│ hacker browser  │ ──attacks──▶ │  (in-memory, no database)        │
└─────────────────┘              └──────────────────────────────────┘
```

Three rules carry the whole game, all enforced in `party/main.ts`:

1. **Roles never appear on a snapshot.** Snapshots are broadcast, so a `role`
   field on one would hand the Hacker away in devtools. Roles are per-connection.
2. **The Hacker is never sent the feed.** There is no client-side branch to flip,
   because the packets do not arrive at that connection at all.
3. **Task credit is decided by the server.** A client reports that it *worked*,
   never that it *finished*. The Hacker's work emits identical packets but is
   silently discarded, which is what makes their task list a convincing fake.

Two packet sources share one subnet: the host's browser generates ambient noise
from devices at `.100+`, and the server emits activity packets from validated
work, sourced from the acting player's own address in `.20-.99`. The ranges are
kept apart so an ambient device can never put traffic on the wire under a
player's name.

The Hacker's attacks reach the host's generator as an anonymous `inject` — the
host learns an attack happened, never who ordered it.

## Round flow

| Phase | What happens |
| --- | --- |
| `lobby` | Join by code. Host can kick, transfer host, and start at 3+ players. |
| `playing` | Everyone works tasks; analysts also read and flag the wire; Hacker attacks. |
| `meeting` | Called by any player, once each. Evidence revealed, then a vote. |
| `ended` | Hacker revealed, with the reason the round ended and a scoreboard. |

An ejected player becomes a spectator and their unfinished work leaves the
denominator, so a wrong vote costs time but never makes the bar unwinnable.
Ejecting the Hacker ends it immediately.

Attack signatures, all in `lib/packets.ts`:

- **Spoofing** — gateway IP answers from a second MAC; gratuitous ARP; duplicate-address warning. Loud, but costs the analysts nothing.
- **Disruption** — SYN flood across climbing ports, retransmissions thickening. **Freezes everyone's task work for 8 seconds** — the only attack that actually buys time.
- **Takeover** — a live session jumps TCP sequence, switches port and protocol, and one analyst's screen is seized for 6 seconds.

## Layout

| Path | What it is |
| --- | --- |
| `lib/protocol.ts` | **Wire protocol.** Shared by client and server; the one source of truth. |
| `lib/packets.ts` | Ambient traffic, activity packets, the three attack signatures. Pure. |
| `lib/tasks.ts` | Task lists and their work units. Pure. |
| `components/Tasks.tsx` | The task panel — typing, clicking, winding. |
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
- [x] **8.** Redesign: packets mirror player activity; tasks as the win condition
- [ ] **9.** Multi-device playtest, tune task length and attack cadence

## Known rough edges

- Room state is in-memory. If every player disconnects, the lobby is gone (the
  "this code exists" marker is persisted, so the code still works).
- A host whose connection actually drops loses the host role permanently, and
  with it the job of generating the feed. A reconnect grace period would fix it.
- The host's browser holds ground truth for the traffic it generates, so a host
  who is also an analyst could read anomalies out of devtools. The server never
  sends ground truth to anyone, but the generator runs client-side by design.
- Players can still join a room whose round has started; they arrive with no
  role or tasks and see an analyst screen.
- **Three players is a knife-edge**: ejecting one analyst leaves 1v1, which is
  parity and an instant Hacker win. Five or six plays far better.
- Attack cooldowns are shown from the client's own last press, so a reconnect
  shows "ready" early. The server still refuses — it just looks wrong for a moment.
- A kick bars the player's tab id for the room's lifetime. Someone who clears
  sessionStorage gets a fresh id and can rejoin.
- No rematch button yet — the `ended` phase is terminal until everyone leaves.
