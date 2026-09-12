"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import usePartySocket from "partysocket/react";
import { PARTYKIT_HOST } from "./partyHost";
import { getTabId } from "./session";

import {
  FEED_WINDOW,
  type ClientMessage,
  type ErrorCode,
  type Packet,
  type Role,
  type RoomSnapshot,
  type ServerMessage,
  type Task,
} from "./protocol";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "closed";

/** A player the hacker has swept for and can now act against. */
export interface KnownHost {
  playerId: string;
  name: string;
  ip: string;
}

export interface UseRoomResult {
  status: ConnectionStatus;
  room: RoomSnapshot | null;
  youId: string | null;
  /** Your private role, or null while in the lobby. */
  role: Role | null;
  /** Analysts only: the rolling packet window. */
  packets: Packet[];
  /** Your own task list. Everyone gets one, including the Hacker. */
  tasks: Task[];
  /** Your own address. You never learn anyone else's from the server. */
  myIp: string | null;
  /** Hacker only: addresses found by sweeping. */
  known: KnownHost[];
  /** Hacker only: true while a sweep is in flight. */
  scanning: boolean;
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
  const [tasks, setTasks] = useState<Task[]>([]);
  const [myIp, setMyIp] = useState<string | null>(null);
  const [known, setKnown] = useState<KnownHost[]>([]);
  const [scanning, setScanning] = useState(false);
  const [flags, setFlags] = useState<Map<number, boolean>>(new Map());
  const [takeoverUntil, setTakeoverUntil] = useState<number | null>(null);
  const [error, setError] = useState<UseRoomResult["error"]>(null);
  const [kickedBy, setKickedBy] = useState<string | null>(null);
  const [hasLeft, setHasLeft] = useState(false);

  useEffect(() => setTabId(getTabId()), []);

  const helloRef = useRef({ name, intent });
  helloRef.current = { name, intent };

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
        case "tasks":
          setTasks(msg.tasks);
          break;
        case "whoami":
          setMyIp(msg.ip);
          break;
        case "scanResult":
          setScanning(false);
          setKnown((cur) =>
            cur.some((k) => k.ip === msg.ip)
              ? cur
              : [...cur, { playerId: msg.playerId, name: msg.name, ip: msg.ip }],
          );
          break;
        case "compromised":
          // Nothing to set: the snapshot marks you out, and that drives the UI.
          break;
        case "packets":
          // Bounded window: a long round would otherwise grow this forever and
          // drag the render down with it.
          setPackets((cur) => {
            const next = cur.concat(msg.packets);
            return next.length > FEED_WINDOW ? next.slice(-FEED_WINDOW) : next;
          });
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
          // A refused sweep never started, so clear the pending state.
          if (msg.code === "on_cooldown" || msg.code === "scanning") setScanning(false);
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
    (msg: ClientMessage) => {
      if (typeof msg === "object" && msg.type === "scan") setScanning(true);
      socket.send(JSON.stringify(msg));
    },
    [socket],
  );

  // A new round starts from nothing known.
  useEffect(() => {
    if (room?.phase === "lobby") {
      setPackets([]);
      setFlags(new Map());
      setRole(null);
      setTasks([]);
      setKnown([]);
      setScanning(false);
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
    tasks,
    myIp,
    known,
    scanning,
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
