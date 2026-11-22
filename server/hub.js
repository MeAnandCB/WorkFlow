// Server-Sent Events hub: pushes live updates (chat, notifications, board changes) to browsers
const clients = new Map(); // userId -> Set(res)

export function addClient(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  res.on('close', () => {
    const set = clients.get(userId);
    if (set) { set.delete(res); if (!set.size) clients.delete(userId); }
  });
}

export function sendTo(userIds, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const id of new Set(userIds)) {
    const set = clients.get(id);
    if (!set) continue;
    for (const res of set) { try { res.write(payload); } catch { /* closed */ } }
  }
}

export function broadcast(event, data) {
  sendTo([...clients.keys()], event, data);
}

setInterval(() => {
  for (const set of clients.values()) for (const res of set) { try { res.write(': ping\n\n'); } catch { /* closed */ } }
}, 25000).unref();
