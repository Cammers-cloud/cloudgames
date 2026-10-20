export async function onRequest(context) {
  const namespace = context.env.CLOUDPLAY_QUEUE;
  if (!namespace) {
    return Response.json({
      error: "Queue backend is not configured.",
      setup: "Create and bind a Durable Object namespace named CLOUDPLAY_QUEUE, then redeploy Pages."
    }, { status: 503 });
  }
  const id = namespace.idFromName("cloudplay-global-queue-v1");
  const stub = namespace.get(id);
  const url = new URL(context.request.url);
  const target = new URL(url.pathname.replace(/^\/api/, "") + url.search, "https://queue.internal");
  return stub.fetch(new Request(target, context.request));
}
