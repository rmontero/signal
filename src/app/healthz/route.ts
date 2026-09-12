export const runtime = "nodejs";

/** Public process liveness; dependency state is intentionally not exposed. */
export function GET(): Response {
  return Response.json({ status: "ok" });
}
