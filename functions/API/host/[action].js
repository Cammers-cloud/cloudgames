import { forwardToQueue } from "../_forward.js";

const allowed = new Set(["register", "heartbeat", "claim", "ready", "fail", "finish"]);

export async function onRequest(context) {
  const action = context.params.action;
  if (!allowed.has(action)) {
    return Response.json({ error: "Unknown host API route." }, { status: 404 });
  }
  return forwardToQueue(context, `/host/${action}`);
}
