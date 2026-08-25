import { ownerKeyFrom } from "../guard";

export const dynamic = "force-dynamic";

// A cheap owner-gated round-trip target: the dashboard's own client-side connection check uses it
// to tell "the server is gone" apart from "this tab lost the network".
export function GET(request) {
  if (ownerKeyFrom(request) === null) return new Response("Not found", { status: 404 });
  return Response.json({ ok: true, now: Date.now() });
}
