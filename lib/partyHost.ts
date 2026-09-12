/**
 * Where the PartyKit room server lives.
 *
 * When the app is served by PartyKit itself, the page and the room server share
 * an origin, so the socket host is simply wherever the page came from — no
 * configuration, and nothing to get wrong at deploy time.
 *
 * Two exceptions:
 *  - Local dev runs Next on :3000 and `partykit dev` on :1999, so localhost is
 *    redirected to the party port.
 *  - NEXT_PUBLIC_PARTYKIT_HOST still overrides everything, for anyone hosting
 *    the frontend separately (on Vercel, say) from the room server.
 *
 * Resolved lazily rather than at module scope: with a static export there is no
 * `window` at build time, and baking a value in is exactly the trap this avoids.
 */
export function getPartyHost(): string {
  const configured = process.env.NEXT_PUBLIC_PARTYKIT_HOST;
  if (configured) return configured;

  // Prerender only. The socket never opens until after mount.
  if (typeof window === "undefined") return "127.0.0.1:1999";

  const { hostname, host } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return `${hostname}:1999`;
  }
  return host;
}
