/**
 * Where the PartyKit room server lives.
 *
 * Local dev defaults to the `partykit dev` port. In production set
 * NEXT_PUBLIC_PARTYKIT_HOST to the deployed host (e.g. netsleuth.you.partykit.dev)
 * in the Vercel project env vars.
 */
export const PARTYKIT_HOST =
  process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "127.0.0.1:1999";
