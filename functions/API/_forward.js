
export async function forwardToQueue(context, targetPath) {
  const namespace = context.env.CLOUDPLAY_QUEUE;

  if (!namespace) {
    return Response.json(
      {
        ok: false,
        error: "CLOUDPLAY_QUEUE binding is missing.",
        route: targetPath
      },
      {
        status: 503,
        headers: { "cache-control": "no-store" }
      }
    );
  }

  try {
    const id = namespace.idFromName("cloudplay-global-queue-v1");
    const stub = namespace.get(id);

    const incoming = context.request;
    const incomingUrl = new URL(incoming.url);
    const targetUrl = new URL(
      targetPath + incomingUrl.search,
      "https://queue.internal"
    );

    const init = {
      method: incoming.method,
      headers: incoming.headers
    };

    if (incoming.method !== "GET" && incoming.method !== "HEAD") {
      init.body = await incoming.arrayBuffer();
    }

    const response = await stub.fetch(
      new Request(targetUrl.toString(), init)
    );

    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-cloudplay-route", "explicit-queue-function");

    return new Response(response.body, {
      status: response.status,
      headers
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: "Queue forwarding failed.",
        details: String(error?.message || error),
        route: targetPath
      },
      {
        status: 502,
        headers: {
          "cache-control": "no-store",
          "x-cloudplay-route": "explicit-queue-function"
        }
      }
    );
  }
}
