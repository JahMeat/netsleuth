"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import usePartySocket from "partysocket/react";
import { PARTYKIT_HOST } from "./partyHost";
import { getTabId } from "./session";
import { createFeed, type Feed } from "./packets";
import {
  FEED_WINDOW,
  type ClientMessage,
  type ErrorCode,
  type Packet,
  type Role,
  type RoomSnapshot,
  type ServerMessage,
} from "./protocol";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "closed";

/** How often the host's browser produces a tick of traffic. */
const TICK_MS = 900;

export interface UseRoomResult {
  status: ConnectionStatus;
  room: RoomSnapshot | null;
  youId: string | null;
  /** Your private role, or null while in the lobby. */
  role: Role | null;
  /** Benign only: the rolling packet window. */
  packets: Packet[];
  /** Sequence numbers you flagged, mapped to whether they were real. */
  flags: Map<number, boolean>;
  /** Epoch ms until which your screen is seized, or null. */
  takeoverUntil: number | null;
  error: { code: ErrorCode; message: string } | null;
  kickedBy: string | null;
  hasLeft: boolean;
  leave: () => void;
  rejoin: () => void;
  send: (msg: ClientMessage) => void;
}

export function useRoom(options: {
  code: string;
  name: string;
  intent: "create" | "join";
}): UseRoomResult {
  const { code, name, intent } = options;

  const [tabId, setTabId] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [youId, setYouId] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [packets, setPackets] = useState<Packet[]>([]);
  const [flags, setFlags] = useState<Map<number, boolean>>(new Map());
  const [takeoverUntil, setTakeoverUntil] = useState<number | null>(null);
  const [error, setError] = useState<UseRoomResult["error"]>(null);
  const [kickedBy, setKickedBy] = useState<string | null>(null);
  const [hasLeft, setHasLeft] = useState(false);

  useEffect(() => setTabId(getTabId()), []);

  const helloRef = useRef({ name, intent });
  helloRef.current = { name, intent };

  /**
   * The host's traffic generator. Held in a ref because it is long-lived,
   * stateful, and must survive re-renders without being rebuilt — rebuilding it
   * would reset sequence numbers mid-round and make the feed obviously fake.
   */
  const feedRef = useRef<Feed | null>(null);

  const socket = usePartySocket({
    host: PARTYKIT_HOST,
    room: code,
    id: tabId ?? undefined,
    enabled: tabId !== null && kickedBy === null && !hasLeft,

    onOpen() {
      setStatus("connected");
      setError(null);
      const { name, intent } = helloRef.current;
      socket.send(
        JSON.stringify({ type: "hello", intent, name } satisfies ClientMessage),
      );
    },

    onMessage(event: MessageEvent) {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }

      switch (msg.type) {
        case "snapshot":
          setRoom(msg.room);
          setYouId(msg.youId);
          break;
        case "role":
          setRole(msg.role);
          break;
        case "packets":
          // Bounded window: a long round would otherwise grow this forever and
          // drag the render down with it.
          setPackets((cur) => {
            const next = cur.concat(msg.packets);
            return next.length > FEED_WINDOW ? next.slice(-FEED_WINDOW) : next;
          });
          break;
        case "inject":
          feedRef.current?.inject(msg.kind, msg.victimLabel);
          break;
        case "takeover":
          setTakeoverUntil(msg.untilMs);
          break;
        case "flagAck":
          setFlags((cur) => new Map(cur).set(msg.seq, msg.hit));
          break;
        case "kicked":
          setKickedBy(msg.byName);
          break;
        case "error":
          setError({ code: msg.code, message: msg.message });
          break;
      }
    },

    onClose() {
      setStatus("closed");
    },
  });

  useEffect(() => {
    if (tabId !== null && status === "idle") setStatus("connecting");
  }, [tabId, status]);

  const send = useCallback(
    (msg: ClientMessage) => socket.send(JSON.stringify(msg)),
    [socket],
  );

  const youAreHost = room?.players.some((p) => p.id === youId && p.isHost) ?? false;
  const playing = room?.phase === "playing";

  /**
   * Host-authoritative generation: only the host's browser produces traffic, and
   * it ships every tick to the server, which decides who is allowed to see it.
   */
  useEffect(() => {
    if (!youAreHost || !playing) return;

    if (!feedRef.current) feedRef.current = createFeed();
    const feed = feedRef.current;

    const id = setInterval(() => {
      const batch = feed.tick();
      if (batch.length > 0) send({ type: "feed", packets: batch });
    }, TICK_MS);

    return () => clearInterval(id);
  }, [youAreHost, playing, send]);

  // A new round deserves a fresh network and fresh sequence numbers.
  useEffect(() => {
    if (room?.phase === "lobby") {
      feedRef.current = null;
      setPackets([]);
      setFlags(new Map());
      setRole(null);
    }
  }, [room?.phase]);

  const leave = useCallback(() => {
    setHasLeft(true);
    socket.close();
  }, [socket]);

  const rejoin = useCallback(() => setHasLeft(false), []);

  return {
    status,
    room,
    youId,
    role,
    packets,
    flags,
    takeoverUntil,
    error,
    kickedBy,
    hasLeft,
    leave,
    rejoin,
    send,
  };
}
