"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import usePartySocket from "partysocket/react";
import { PARTYKIT_HOST } from "./partyHost";
import { getTabId } from "./session";
import type { ClientMessage, ErrorCode, RoomSnapshot, ServerMessage } from "./protocol";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "closed";

export interface UseRoomResult {
  status: ConnectionStatus;
  /** Latest room state from the server, or null before the first snapshot. */
  room: RoomSnapshot | null;
  /** This connection's player id, for picking yourself out of `room.players`. */
  youId: string | null;
  error: { code: ErrorCode; message: string } | null;
  /** Set once the host removes you. Terminal: the socket stays closed. */
  kickedBy: string | null;
  /** True once you have deliberately left. Terminal, like being kicked. */
  hasLeft: boolean;
  /**
   * Leave the lobby on purpose. Closing the tab does the same thing — the
   * server drops you when the socket closes either way — but this makes it a
   * choice rather than something you have to know.
   */
  leave: () => void;
  /**
   * Undo a leave. Needed as an explicit action because the leave screen lives at
   * the room URL: navigating to /room/CODE from there is a no-op route change,
   * so the component never remounts and `hasLeft` would survive the trip.
   */
  rejoin: () => void;
  send: (msg: ClientMessage) => void;
}

/**
 * Connects to one PartyKit room and keeps a mirror of its state.
 *
 * The room server is the single source of truth: this hook never mutates
 * `room` locally, it only replaces it with whatever the server last sent.
 */
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
  const [error, setError] = useState<UseRoomResult["error"]>(null);
  const [kickedBy, setKickedBy] = useState<string | null>(null);
  const [hasLeft, setHasLeft] = useState(false);

  // sessionStorage is unavailable during SSR, so identity resolves post-mount
  // and the socket stays disabled until then.
  useEffect(() => setTabId(getTabId()), []);

  // Kept in a ref so the socket's onOpen callback always sees current values
  // without needing to tear the connection down and rebuild it.
  const helloRef = useRef({ name, intent });
  helloRef.current = { name, intent };

  const socket = usePartySocket({
    host: PARTYKIT_HOST,
    room: code,
    id: tabId ?? undefined,
    // Being kicked or leaving disables the socket outright. Without this,
    // partysocket's automatic reconnect would immediately dial back in — into a
    // room the server has barred us from, or one we just chose to quit.
    enabled: tabId !== null && kickedBy === null && !hasLeft,

    onOpen() {
      setStatus("connected");
      setError(null);
      // Re-announced on every open, so an automatic reconnect re-seats the
      // player rather than leaving them invisible to everyone else.
      const { name, intent } = helloRef.current;
      socket.send(JSON.stringify({ type: "hello", intent, name } satisfies ClientMessage));
    },

    onMessage(event: MessageEvent) {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === "snapshot") {
        setRoom(msg.room);
        setYouId(msg.youId);
      } else if (msg.type === "kicked") {
        setKickedBy(msg.byName);
      } else if (msg.type === "error") {
        setError({ code: msg.code, message: msg.message });
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

  const leave = useCallback(() => {
    setHasLeft(true);
    socket.close();
  }, [socket]);

  // Re-enabling the socket reconnects it, and onOpen re-sends `hello`, which
  // re-seats the player. No extra message type needed.
  const rejoin = useCallback(() => setHasLeft(false), []);

  return { status, room, youId, error, kickedBy, hasLeft, leave, rejoin, send };
}
