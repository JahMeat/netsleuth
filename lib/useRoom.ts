"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import usePartySocket from "partysocket/react";
import { PARTYKIT_HOST } from "./partyHost";
import { getTabId } from "./session";
import type { ClientMessage, RoomSnapshot, ServerMessage } from "./protocol";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "closed";

export interface UseRoomResult {
  status: ConnectionStatus;
  /** Latest room state from the server, or null before the first snapshot. */
  room: RoomSnapshot | null;
  /** This connection's player id, for picking yourself out of `room.players`. */
  youId: string | null;
  error: { code: string; message: string } | null;
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
    enabled: tabId !== null,

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

  return { status, room, youId, error, send };
}
