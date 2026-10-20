
import { forwardToQueue } from "../_forward.js";

export async function onRequestPost(context) {
  return forwardToQueue(context, "/queue/join");
}
