// Shared Pages Function forwarder for the CloudPlay Durable Object queue.
export async function forwardToQueue(context, targetPath) {
  const namespace = context.env.CLOUDPLAY_QUEUE;
  if (!namespace) {
    return Response.json({
      error: "Queue backend is not configured.",
      setup: "Bind the CloudPlayQueue Durable Object as CLOUDPLAY_QUEUE in the Pages project and redeploy."
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }

  const id = namespace.idFromName("cloudplay-global-queue-v1");
  const stub = namespace.get(id);
  const incoming = context.request;
  const incomingUrl = new URL(incoming.url);
  const target = new URL(targetPath + incomingUrl.search, "https://queue.internal");
  const response = await stub.fetch(new Request(target, incoming));
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-cloudplay-route", "explicit-queue-function");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
