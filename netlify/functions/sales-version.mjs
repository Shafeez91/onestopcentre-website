// AI Sales — which deploy is live. The dashboard is a single page that stays open for hours, so after a new release
// it would keep running the old code; it compares this id with the one it loaded with and offers a reload.
// Returns only Netlify's deploy id (no data, no settings), so it needs no sign-in.
export default async (req, context) => new Response(JSON.stringify({ deploy: context?.deploy?.id || process.env.DEPLOY_ID || process.env.COMMIT_REF || null }), {
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

export const config = { path: "/api/sales/version", method: ["GET"], rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ["ip", "domain"] } };
