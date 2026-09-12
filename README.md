# NETSLEUTH

**One of you is a hacker. The network will tell you who — if you can read it.**

A social deduction game where everything you do shows up as network traffic, and
everything the hacker does shows up too.

*New here? The next 60 seconds is all you need to start.*

---

## The 60-second version

- Everyone gets a **secret address** like `192.168.4.37`. You know yours. **You do not know anyone else's.**
- Everyone gets **4 tasks**. Doing them fills a **shared progress bar**.
- **Doing a task puts packets on the wire from your address.** Sitting still puts nothing.
- One player is the **hacker**. Their tasks look real to them but never fill the bar.
- **Analysts win** by finishing every task, or by voting the hacker out.
- **The hacker wins** by running out the clock, or by picking analysts off until one is left.
- Anyone can call **one meeting**. You argue, you vote, someone gets thrown out.

The whole game is the gap between *"something nasty came from `.37`"* and
*"okay, so who is `.37`?"*

---

## Before you start

**You need at least 3 players — but play with 5 or 6.** At 3, losing one analyst
ends the round instantly, so nobody gets to play.

**You need to be able to talk to each other.** There is no chat in the game.
Same room, or a voice call. The app handles the wire and the vote; the accusing
is on you.

**Joining:** one person clicks **Create lobby** and reads out the 6-character
code, or just sends the link — it already has the code in it. Everyone else
opens it and picks a name.

The host starts the round when everyone's in.

---

## Your screen

Once the round starts you get **tasks on the left, the wire on the right**.

| Where | What it is |
| --- | --- |
| Top bar | Shared progress, the round clock, and **Call meeting** |
| Left | Your 4 tasks, and who's in the room |
| Right | The live packet feed, with a **flag** button on every line |

Your own address is shown next to your name, and only to you. Your own packets
are marked `you` in the feed so you can tell your trail from everyone else's.

A round is **5 minutes**.

---

## If you're an Analyst

You have two jobs and **you cannot do both at once**. That is the game.

**Job one: do your tasks.** Four of them, drawn from three kinds: type a phrase,
clear six alerts, wind a handle ten times. They're easy. They just need
attention.

**Job two: watch the wire.** Every packet has a source address. Hostile traffic
looks nothing like ordinary work once you've seen it (see below). Hit **flag**
on anything suspicious — you'll be told instantly whether you were right, and
flagged packets become public evidence in the meeting.

### The squeeze

Heads-down on your tasks moves the bar but **you see nothing**.

Watching the wire catches the hacker but **your address goes quiet** — and a
quiet address is exactly what everyone will be hunting for.

Talk to each other. Somebody should be watching. Say so out loud.

---

## If you're the Hacker

You get the same task list as everyone else. **Do them.** They complete on your
screen and they put exactly the same packets on the wire as real work — they
just never move the shared bar. With no background traffic to hide in, faking
work is the only thing keeping you from being the obvious silent address.

You have three tools, in the order you'll use them:

**1. Sweep** — pick a player and hunt for their address. Takes **6 seconds** to
come back, then a **20-second** cooldown. This is loud: the sweep goes out from
your address, so everyone watching sees it *and* sees which address sent it.
What they don't know is that the address is yours.

**2. Compromise** — kill an address you've already swept for. The game refuses
any address you haven't found. **35 seconds** between kills. A compromised
player is out for good.

**3. Attacks** — noise and delay. 25 seconds each, 10 seconds between any two.

| Attack | What it does |
| --- | --- |
| **Disruption** | Freezes *everyone's* task work for 8 seconds. The only one that actually buys you time. |
| **Spoofing** | Very loud, costs the analysts nothing. Pure misdirection. |
| **Takeover** | Blacks out one analyst's screen for 6 seconds. |

### The thing to understand

**Every hostile act comes from your address.** Sweeps, kills, attacks — all of
it, same source. The moment someone connects two hostile lines to the same
address, they have your address. They still have to work out that it's *you* —
so be ready to have an answer about which address is yours.

---

## Reading the wire

This is the actual skill. Ordinary work looks like this:

```
192.168.4.37 → 192.168.4.1   HTTP   POST /api/notes keystroke batch (7 chars)
192.168.4.37 → 192.168.4.1   HTTP   POST /api/actions/ack id=4821
192.168.4.37 → 192.168.4.1   WS     WebSocket frame: relay.step seq=204
```

Somebody typing, clicking, winding. Boring. That's the point — **that's what a
busy, innocent player looks like.**

Here's what isn't boring:

### Somebody is hunting

```
192.168.4.37 → 255.255.255.255   ARP   Who has 192.168.4.0/24? (address sweep)
192.168.4.37 → 192.168.4.61      TCP   Probe 192.168.4.61 — host discovery
```

A sweep. Someone is looking for people's addresses, and **`.37` is the hacker**.
Say the address out loud immediately.

### Somebody just died

```
192.168.4.37 → 192.168.4.61   SSH   Auth attempt on 192.168.4.61 — replayed session key
192.168.4.61 → 192.168.4.37   SSH   Auth accepted — new shell opened
192.168.4.37 → 192.168.4.61   SSH   Account on 192.168.4.61 locked out
```

A compromise. `.61` is gone, and `.37` did it.

### The gateway is lying

```
192.168.4.37 → 255.255.255.255   ARP   192.168.4.1 is at a4:1c:… (duplicate use of 192.168.4.1 detected)
192.168.4.37 → 192.168.4.1       ARP   Gratuitous ARP — default gateway MAC changed mid-session
```

Spoofing. One address can't belong to two machines — that's the "duplicate use"
warning telling you someone is impersonating the gateway.

### The flood

```
192.168.4.37 → 192.168.4.1   TCP   Seq=0 Win=1024 Len=0 MSS=1460
192.168.4.37 → 192.168.4.1   TCP   [TCP Retransmission] Seq=0 Win=1024 Len=0
        ... ten of them, climbing ports, retransmissions piling up ...
```

Disruption — and if your tasks just froze, this is why.

### The hijack

```
192.168.4.37 → 192.168.4.61   TCP      Seq=2638495 (previous Seq=376449) — sequence jump
192.168.4.61 → 192.168.4.37   TELNET   Session switched TLS -> TELNET on established stream
```

A takeover. A conversation that suddenly stops behaving like itself.

> **The one rule that matters:** you're not looking for *packets*, you're looking
> for an **address**. Every hostile line above has the same source. Find the
> address that misbehaves and you've found the hacker's machine.

---

## Meetings and voting

Anyone can call **one meeting per round**. Use it when you have something —
calling it with nothing wastes the only one you get.

Everything anyone flagged becomes public, labelled with **who flagged it** and
whether it was genuinely hostile or just ordinary traffic. Someone who flagged
five things and hit nothing looks careless. Or looks like they're making noise.

Your own address is shown on the meeting screen. **Nobody else can see it.**
Claiming it is a move — and so is staying quiet. So is lying.

You get **75 seconds** and one vote each. **A tie throws nobody out.** You can
skip.

**The round clock does not stop.** A meeting is 75 seconds off your 5 minutes, so
calling one is a real cost to the analysts even when it catches somebody.

Voting out an analyst doesn't end the round — they become a spectator, and their
unfinished tasks come off the bar, so a wrong vote costs you time but never
makes the game unwinnable.

---

## How a round ends

**Analysts win when:**
- every task is finished, or
- the hacker gets voted out

**The hacker wins when:**
- the 5 minutes run out with work unfinished, or
- only one analyst is left standing — compromised, voted out, or simply gone

If the hacker disconnects, they forfeit and the analysts take it.

Then you see who it was, why it ended, and a scoreboard: tasks done, correct
flags, wrong flags. The host can hit **Play again** — everyone gets new roles,
and **new addresses**, so nothing you learned carries over.

---

## First game? Read this bit.

**As an analyst:**
- **Do your tasks.** Genuinely. A round lost to nobody working is a boring round.
- Say your address out loud early. It costs you almost nothing and makes everyone
  else's deductions possible.
- When you flag a hit, **say the source address**, not "I found something".
- Don't burn your meeting on a hunch.

**As the hacker:**
- **Work first.** Do a couple of real-looking tasks before you touch anything else.
  Silence is what gets you caught, not attacks.
- Sweep when people are heads-down, not right after a meeting.
- Disruption is your only real weapon against the bar. Spoofing is a decoy —
  fire it somewhere far from where you're about to kill.
- Have your lie ready before someone asks whose address is whose.

**Everyone:** the game is played out loud. The screen just gives you something
true to argue about.

---

## Common confusions

**"I can't see anyone's address."** Correct. You only ever see your own. Working
out the rest is the game.

**"My screen went black."** A takeover. Six seconds. Say so — it's evidence that
an attack just happened.

**"My tasks stopped working."** A disruption flood. Eight seconds, hits everyone.

**"I flagged something and it said miss."** Ordinary traffic. Harmless, but the
room sees your misses in the meeting.

**"I'm out — can I still do anything?"** You can watch the wire. You can't work,
flag, or vote. No talking, either, if you want the round to stay fair.

---

<sub>Running or deploying it? See [DEVELOPING.md](DEVELOPING.md).</sub>
