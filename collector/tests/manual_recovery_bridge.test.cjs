'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { WebSocket, WebSocketServer } = require('ws');
const { bridgeWithBackpressure } = require('../src/api/manual_recovery.cjs');

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('VNC 转发：浏览器端读得慢时暂停读取 VNC，缓冲有上限，恢复后数据完整', async () => {
  const total = 48 * 1024 * 1024;
  const chunk = Buffer.alloc(64 * 1024, 7);
  // Stand-in for x11vnc: writes `total` bytes as fast as the socket accepts.
  const vnc = net.createServer((socket) => {
    let sent = 0;
    const pump = () => {
      while (sent < total) {
        sent += chunk.length;
        if (!socket.write(chunk)) return socket.once('drain', pump);
      }
      socket.end();
    };
    pump();
  });
  const vncPort = await listen(vnc);
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  let serverWs;
  let stats;
  wss.on('connection', (ws) => {
    serverWs = ws;
    stats = bridgeWithBackpressure(ws, net.connect(vncPort, '127.0.0.1'), { high: 512 * 1024, low: 128 * 1024 });
  });
  const port = await listen(httpServer);
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  let received = 0;
  client.on('message', (data) => {
    received += data.length;
  });
  await new Promise((resolve) => client.once('open', resolve));
  client.pause(); // The admin's browser stops reading.
  try {
    let peak = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(25);
      peak = Math.max(peak, serverWs?.bufferedAmount || 0);
    }
    assert.ok(stats.pausedTcp >= 1, 'VNC reads were never paused');
    // Bounded by the high-water mark plus at most one TCP read.
    assert.ok(peak < 512 * 1024 + 256 * 1024, `buffered ${peak} bytes`);
    client.resume();
    const deadline = Date.now() + 20000;
    while (received < total && Date.now() < deadline) await sleep(20);
    assert.equal(received, total);
  } finally {
    client.terminate();
    wss.close();
    httpServer.close();
    vnc.close();
  }
});
