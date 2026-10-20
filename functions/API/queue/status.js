
import { forwardToQueue } from "../_forward.js";

export async function onRequestGet(context) {
  return forwardToQueue(context, "/queue/status");
}
