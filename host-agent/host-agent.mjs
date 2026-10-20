import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const API = (process.env.CLOUDPLAY_API || "").replace(/\/$/, "");
const TOKEN = process.env.CLOUDPLAY_HOST_TOKEN || "";
const HOST_ID = process.env.CLOUDPLAY_HOST_ID || `host-${process.env.COMPUTERNAME || process.env.HOSTNAME || "desktop"}`;
const HOST_LABEL = process.env.CLOUDPLAY_HOST_LABEL || HOST_ID;
if (!API || !TOKEN) {
  console.error("Set CLOUDPLAY_API to your deployed site origin and CLOUDPLAY_HOST_TOKEN to the secret configured on the Worker.");
  process.exit(1);
}
const rl = readline.createInterface({ input, output });
let activeTicket = null;
let running = true;
async function call(path, body) {
  const res = await fetch(`${API}/api${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}
async function heartbeat() {
  try { await call("/host/heartbeat", { hostId: HOST_ID }); }
  catch (e) { if (String(e.message).includes("not registered")) await call("/host/register", { hostId: HOST_ID, label: HOST_LABEL }); else console.error("Heartbeat:", e.message); }
}
async function prepareTicket(ticket) {
  activeTicket = ticket;
  console.log(`\nSESSION ASSIGNED: ${ticket.id}`);
  console.log("This agent only coordinates queue status. On this host, manually open Roblox and the approved screen-share workflow.");
  console.log("After the desktop is genuinely prepared, type READY. Type FAIL to return an error, or FINISH to close the session.\n");
  while (running && activeTicket?.id === ticket.id) {
    const answer = (await rl.question("host> ")).trim().toLowerCase();
    if (answer === "ready") {
      try { const result = await call("/host/ready", { hostId: HOST_ID, ticketId: ticket.id }); console.log(result.ticket?.message || "Marked ready."); activeTicket = null; }
      catch (e) { console.error(e.message); }
    } else if (answer === "fail") {
      const reason = await rl.question("Reason (short): ");
      try { await call("/host/fail", { hostId: HOST_ID, ticketId: ticket.id, reason }); console.log("Ticket marked failed."); activeTicket = null; }
      catch (e) { console.error(e.message); }
    } else if (answer === "finish") {
      try { await call("/host/finish", { hostId: HOST_ID, ticketId: ticket.id }); console.log("Session finished."); activeTicket = null; }
      catch (e) { console.error(e.message); }
    } else if (answer === "help") console.log("Commands: ready, fail, finish, help");
    else console.log("Use ready, fail, finish, or help.");
  }
}
async function main() {
  console.log(`CloudPlay host coordinator · ${HOST_LABEL}`);
  await call("/host/register", { hostId: HOST_ID, label: HOST_LABEL });
  console.log("Registered. Waiting for queue requests. Ctrl+C to stop.");
  const beat = setInterval(() => heartbeat().catch(e => console.error("Heartbeat:", e.message)), 15000);
  process.on("SIGINT", () => { running = false; clearInterval(beat); rl.close(); process.exit(0); });
  while (running) {
    try {
      await heartbeat();
      if (!activeTicket) {
        const result = await call("/host/claim", { hostId: HOST_ID });
        if (result.ticket) await prepareTicket(result.ticket);
      }
    } catch (e) { console.error("Coordinator error:", e.message); }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  clearInterval(beat); rl.close();
}
main().catch(error => { console.error(error); process.exit(1); });
