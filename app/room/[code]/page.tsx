import Lobby from "@/components/Lobby";
import { sanitizeRoomCode } from "@/lib/roomCode";

/**
 * `params` is a Promise in Next 16 and must be awaited.
 * Codes are normalized here so /room/abc123 and /room/ABC123 are one room.
 */
export default async function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <Lobby code={sanitizeRoomCode(code)} />;
}
