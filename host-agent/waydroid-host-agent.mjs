import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const API = (process.env.CLOUDPLAY_API || '').replace(/\/$/, '');
const TOKEN = process.env.CLOUDPLAY_HOST_TOKEN || '';
const HOST_ID = process.env.CLOUDPLAY_HOST_ID || `waydroid-${process.env.HOSTNAME || 'linux-host'}`;
const HOST_LABEL = process.env.CLOUDPLAY_HOST_LABEL || 'Waydroid Android host';
const PACKAGE = process.env.CLOUDPLAY_ANDROID_PACKAGE || 'com.roblox.client';
const rl = readline.createInterface({ input, output });
let activeTicket = null;
let running = true;
let sessionProcess = null;

if (process.platform !== 'linux') {
  console.error('This agent must run on a Linux host with Waydroid installed.');
  process.exit(1);
}
if (!API || !TOKEN) {
  console.error('Set CLOUDPLAY_API to your deployed CloudPlay origin and CLOUDPLAY_HOST_TOKEN to the Worker secret.');
  process.exit(1);
}

async function run(command, args = [], options = {}) {
  try {
    const result = await execFileAsync(command, args, { timeout: 20000, maxBuffer: 1024 * 1024, ...options });
    return `${result.stdout || ''}${result.stderr || ''}`.trim();
  } catch (error) {
    const detail = `${error.stdout || ''}${error.stderr || ''}`.trim();
    throw new Error(detail || error.message || `${command} failed`);
  }
}
async function api(path, body) {
  const response = await fetch(`${API}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return data;
}
async function waydroidStatus() {
  return await run('waydroid', ['status']);
}
async function prepareAndroid() {
  const status = await waydroidStatus();
  console.log(`Waydroid status:\n${status || '(no status output)'}`);
  if (!/Session:\s*RUNNING/i.test(status)) {
    console.log('Starting the Waydroid user session…');
    // Keep the session attached to this logged-in desktop user.
    sessionProcess = spawn('waydroid', ['session', 'start'], { stdio: 'inherit', detached: false });
    await new Promise(resolve => setTimeout(resolve, 2500));
    const updated = await waydroidStatus();
    console.log(`Waydroid status after start:\n${updated || '(no status output)'}`);
    if (!/Session:\s*RUNNING/i.test(updated)) {
      throw new Error('Waydroid session is not running. Start the container in another terminal with `sudo waydroid container start`, then run this agent again.');
    }
  }
  console.log('Opening the Android UI…');
  await run('waydroid', ['show-full-ui']);
  console.log(`Attempting to launch Android package ${PACKAGE}…`);
  await run('waydroid', ['app', 'launch', PACKAGE]);
  console.log('Launch command returned. Verify the app actually opened and can join a game before marking the session ready.');
}
async function heartbeat() {
  try { await api('/host/heartbeat', { hostId: HOST_ID }); }
  catch (error) {
    if (String(error.message).includes('not registered')) await api('/host/register', { hostId: HOST_ID, label: HOST_LABEL });
    else console.error('Heartbeat:', error.message);
  }
}
async function handleTicket(ticket) {
  activeTicket = ticket;
  console.log(`\nSESSION ASSIGNED: ${ticket.id}`);
  try {
    await prepareAndroid();
    console.log('\nNext: open CloudPlay on this host, click Share screen, and select the Waydroid window/display. Create an offer and complete the WebRTC handshake with the queued client.');
    console.log('Important: the current browser input channel only demonstrates received input in the test panel; it does not yet inject remote controls into Waydroid. Do not advertise this as playable until a verified input adapter is installed.');
  } catch (error) {
    console.error(`Waydroid preparation failed: ${error.message}`);
    const choice = (await rl.question('Mark this ticket failed? Type FAIL to return it as failed, or leave it assigned and troubleshoot: ')).trim().toLowerCase();
    if (choice === 'fail') {
      await api('/host/fail', { hostId: HOST_ID, ticketId: ticket.id, reason: error.message.slice(0, 250) });
      activeTicket = null;
      return;
    }
  }
  while (running && activeTicket?.id === ticket.id) {
    const answer = (await rl.question('waydroid-host> ')).trim().toLowerCase();
    if (answer === 'ready') {
      console.log('Only type READY if the Android app is visibly running and the stream is connected.');
      const confirm = (await rl.question('Confirm actual app + video stream are working? Type YES: ')).trim().toLowerCase();
      if (confirm !== 'yes') { console.log('Not marked ready.'); continue; }
      try {
        const result = await api('/host/ready', { hostId: HOST_ID, ticketId: ticket.id });
        console.log(result.ticket?.message || 'Marked ready.');
        activeTicket = null;
      } catch (error) { console.error(error.message); }
    } else if (answer === 'fail') {
      const reason = await rl.question('Reason (short): ');
      try { await api('/host/fail', { hostId: HOST_ID, ticketId: ticket.id, reason }); console.log('Ticket marked failed.'); activeTicket = null; }
      catch (error) { console.error(error.message); }
    } else if (answer === 'finish') {
      try { await api('/host/finish', { hostId: HOST_ID, ticketId: ticket.id }); console.log('Session finished.'); activeTicket = null; }
      catch (error) { console.error(error.message); }
    } else if (answer === 'status') {
      try { console.log(await waydroidStatus()); } catch (error) { console.error(error.message); }
    } else if (answer === 'help') {
      console.log('Commands: ready (requires app + stream confirmation), fail, finish, status, help');
    } else {
      console.log('Use ready, fail, finish, status, or help.');
    }
  }
}
async function main() {
  console.log(`CloudPlay Waydroid host agent · ${HOST_LABEL}`);
  console.log(`Android package target: ${PACKAGE}`);
  console.log('Preflight: Waydroid requires a compatible Linux desktop session. Roblox may reject virtual Android environments in some experiences.');
  console.log(await waydroidStatus());
  await api('/host/register', { hostId: HOST_ID, label: HOST_LABEL });
  console.log('Registered. Waiting for queue requests. Ctrl+C to stop.');
  const beat = setInterval(() => heartbeat().catch(error => console.error('Heartbeat:', error.message)), 15000);
  process.on('SIGINT', () => {
    running = false;
    clearInterval(beat);
    if (sessionProcess && !sessionProcess.killed) sessionProcess.kill('SIGTERM');
    rl.close();
    process.exit(0);
  });
  while (running) {
    try {
      await heartbeat();
      if (!activeTicket) {
        const result = await api('/host/claim', { hostId: HOST_ID });
        if (result.ticket) await handleTicket(result.ticket);
      }
    } catch (error) { console.error('Coordinator error:', error.message); }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  clearInterval(beat);
  rl.close();
}
main().catch(error => { console.error(error); process.exit(1); });
