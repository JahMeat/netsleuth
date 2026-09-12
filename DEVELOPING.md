# Netsleuth — developer notes

How to run, test and deploy it. For the rules, see [README.md](README.md).

Social deduction where the network traffic *is* the players.

Everyone gets an address and a list of tasks. Doing a task — typing, clicking,
winding — puts packets on the wire from your own address. Nothing else does:
there is no ambient traffic and no outside hosts, so the feed is a complete
record of who has been busy.

**You learn your own address and nobody else's.** That one rule drives both
sides. The Hacker has to sweep for a victim before they can compromise them, and
the analysts have to argue their way from "something hostile came from .38" to
"who here is .38?".

Every hostile act — sweeping, compromising, attacking — emits from the Hacker's
own address. So the analysts are hunting one misbehaving address, and the
Hacker's counter-play is to do fake work from that same address and lie about
which one is theirs.

Analysts win by finishing every task or voting the Hacker out. The Hacker wins by
running out the clock, or by compromising analysts until only one is left.

## Architecture

One PartyKit deployment serves everything: the static Next.js export *and* the
room server, on a single origin.

```
                    PartyKit (one deploy, one origin)
┌─────────────────┐ ┌──────────────────────────────────────────────┐
│ analyst browsers│ │  static Next export  (serve: out/)           │
│ hacker browser  │◀│  room server         (party/main.ts)         │
└─────────────────┘ │  state: players / roles / addresses / tasks  │
                    │  in-memory, no database                      │
                    └──────────────────────────────────────────────┘
```

Because the page and the socket share an origin, the client reads the socket
host straight off the page URL. **There is no environment variable to set.**

Four rules carry the whole game, all enforced in `party/main.ts`:

1. **Roles never appear on a snapshot.** Snapshots are broadcast, so a `role`
   field on one would hand the Hacker away in devtools. Roles are per-connection.
2. **Addresses never appear on a snapshot either.** You are told yours over a
   private message; the mapping exists only on the server.
3. **The Hacker is never sent the feed.** There is no client-side branch to flip,
   because the packets do not arrive at that connection at all.
4. **Task credit is decided by the server.** A client reports that it *worked*,
   never that it *finished*. The Hacker's work emits identical packets but is
   silently discarded, which is what makes their task list a convincing fake.

Every packet is generated server-side from a validated action, so a client cannot
manufacture a trail it did not earn. There is no host-generated traffic any more:
once the feed became a record of people, ambient noise had nobody to belong to.

## Round flow

| Phase | What happens |
| --- | --- |
| `lobby` | Join by code. Host can kick, transfer host, and start at 3+ players. |
| `playing` | Everyone works tasks; analysts read and flag the wire; Hacker sweeps, compromises and attacks. |
| `meeting` | Called by any player, once each. Evidence revealed, then a vote. |
| `ended` | Hacker revealed, with the reason the round ended and a scoreboard. |

A player who is out — voted or compromised — becomes a spectator, and their
unfinished work leaves the denominator, so losing someone costs time but never
makes the bar unwinnable. Ejecting the Hacker ends it immediately.

### The Hacker's loop

1. **Sweep** for a named player. Takes several seconds and is unmistakable on the
   wire — the room sees a scan happen, they just cannot tell whose address did
   it. It probes several live hosts, not only the real target, so the scan does
   not hand over the victim's identity along with itself.
2. **Compromise** an address you have already found. The server refuses any
   address you have not swept for. A compromised account is out for good.
3. **Attack** to buy time, or to look busy.

Hostile signatures, all in `lib/packets.ts`:

- **Sweep** — broadcast ARP sweep plus SYN probes at several live hosts.
- **Compromise** — a replayed session key on port 22, then "account locked out".
- **Spoofing** — gateway address answers from a second MAC. Loud, costs nothing.
- **Disruption** — SYN flood at the gateway. **Freezes everyone's task work for 8 seconds** — the only attack that buys real time.
- **Takeover** — a session jumps TCP sequence and drops TLS for TELNET; one analyst's screen is seized for 6 seconds.

## Layout

| Path | What it is |
| --- | --- |
| `lib/protocol.ts` | **Wire protocol.** Shared by client and server; the one source of truth. |
| `lib/packets.ts` | Every packet shape: work, sweep, compromise, the three attacks. Pure. |
| `lib/tasks.ts` | Task lists and their work units. Pure. |
| `lib/useRoom.ts` | One socket, mirrors server state, holds your private role/address/tasks. |
| `party/main.ts` | Room server — roles, addresses, phases, feed filtering, flags, votes. |
| `components/Tasks.tsx` | The task panel — typing, clicking, winding. |
| `components/Game.tsx` | Analyst monitor, hacker panel, takeover overlay, meeting, results. |
| `components/Lobby.tsx` | Lobby + phase routing. |

## Running locally

```bash
npm install
npm run dev
```

Next on :3000 (with hot reload), PartyKit on :1999. Open
<http://localhost:3000>; a page on localhost knows to dial :1999 for the socket,
so this needs no configuration either.

To check the real deployed shape — one origin, static assets served by PartyKit:

```bash
npm run preview
```

Then open <http://127.0.0.1:1999>. Create a lobby and open the URL in more tabs;
identity is per-tab, so four tabs are four players.

### One page, one route

The whole app is `/`, and a room is `/?code=ABC123`. A dynamic path segment
cannot be statically exported — room codes are random, so there is no list to
prerender — and a static host maps extensionless paths inconsistently: `/room/`
serves while `/room` 404s. Collapsing to one route means no pasted link can land
on a page that does not exist.

## Checking it without a browser

```bash
npm run test:feed      # print every packet shape, with hostile ones marked
npm run test:game      # drive a full round over raw WebSocket
npm run test:restart   # two rounds back to back, checking nothing carries over
npm run test:readme    # every claim the player manual makes, checked
```

`test:readme` is worth keeping green. The manual is the first thing a new player
reads, so a number that drifts there teaches the wrong game. It holds the README
to its own quoted phrases: the timings, the task shapes, every feed line it
prints, and the behaviour it promises (a tie ejects nobody, the hacker can call
a meeting, a hacker who quits forfeits).

Both socket tests need a room server running (`npm run dev:party`) and neither
depends on how it was launched.

`test:game` is the one that matters: it talks straight to the room server, so it
cannot be fooled by UI that merely hides things. It asserts that no address ever
appears in a broadcast snapshot, that the Hacker receives zero packet messages,
that every source on the wire belongs to a player or the gateway, and that a
compromise is refused against an address the Hacker has not swept for.

## Deploying

```bash
npx partykit login   # once
npm run deploy       # builds the static export, then ships both
```

That is the whole deploy. It prints the URL —
`netsleuth.<your-partykit-username>.partykit.dev` — and that single link is the
game. No second host, no environment variables, nothing to keep in sync.

Hosting the frontend elsewhere (Vercel, Netlify) still works: set
`NEXT_PUBLIC_PARTYKIT_HOST` to the deployed room host and it overrides the
same-origin default. See `.env.example`. Note that `NEXT_PUBLIC_*` is inlined at
build time, so changing it needs a rebuild, not just a settings edit.

## Tuning

Round, meeting and sweep timings are PartyKit vars, so they can change without a
code edit — useful during playtesting:

```bash
npx partykit dev --var ROUND_MS=90000 --var MEETING_MS=45000 --var SCAN_MS=3000
```

Everything else lives as constants in `lib/protocol.ts`: attack and compromise
cooldowns, takeover duration, stall length, tasks per player, feed window.

## Build milestones

- [x] **1.** Scaffold, room-join flow end to end
- [x] **2.** Lobby: kick, transfer host, leave
- [x] **2b.** Start-game gate (host only, minimum 3 players)
- [x] **3.** Role assignment, routing to Analyst vs Hacker screens
- [x] **4.** Packet generator with attack signatures
- [x] **5.** Server-side feed, delivered to analysts only
- [x] **6.** Hacker control panel
- [x] **7.** Flagging, round timer, vote + tally + results
- [x] **8.** Redesign: packets mirror player activity; tasks as the win condition
- [x] **9.** Players-only wire; private addresses; sweep and compromise
- [x] **10.** Host restart; single-origin hosting on PartyKit
- [ ] **11.** Multi-device playtest; tune task length, sweep cost, kill cooldown

## Known rough edges

- Room state is in-memory. If every player disconnects, the lobby is gone (the
  "this code exists" marker is persisted, so the code still works).
- The host role now only gates starting the round and the lobby controls; it no
  longer generates anything.
- With no ambient traffic the wire is sparse, so an idle address is glaring. That
  is intended, but it means fake tasks are the Hacker's only cover — if they are
  hunting instead of working, they stand out fast.
- Players can still join a room whose round has started; they arrive with no role
  or tasks and see an analyst screen.
- **Three players is a knife-edge**: losing one analyst leaves 1v1, which is
  parity and an instant Hacker win. Five or six plays far better.
- Cooldown labels on the Hacker panel are driven by that client's own last press,
  so a reconnect shows "ready" early. The server still refuses — it just looks
  wrong for a moment.
- A kick bars the player's tab id for the room's lifetime. Someone who clears
  sessionStorage gets a fresh id and can rejoin.
- On Windows, `partykit dev` can leave an orphaned `workerd` child holding port
  1999, so killing by port starts a second server that silently fails to bind and
  leaves the stale one serving. Kill by command line instead:
  `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "partykit|workerd" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
