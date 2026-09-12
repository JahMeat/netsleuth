import type { NextConfig } from "next";

/**
 * Static export, so PartyKit can serve the whole app next to the room server.
 * Nothing here needs a Node server: the app is a thin client over a WebSocket.
 *
 * The whole app is one page. A room lives at /?code=ABC123 rather than at its
 * own path, because a static host maps extensionless paths inconsistently --
 * /room 404s while /room/ works -- and a stripped trailing slash in a pasted
 * link should not be able to break a lobby.
 */
const nextConfig: NextConfig = {
  output: "export",
};

export default nextConfig;
