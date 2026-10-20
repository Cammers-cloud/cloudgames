import { forwardToQueue } from "../_forward.js";

export async function onRequest(context) {
  return forwardToQueue(context, "/queue/join");
}
