import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function findFreePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, child) {
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) throw new Error(`API process exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The server may still be starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('API server did not become healthy in time');
}

test('HTTP API creates rooms, rotates recovery codes, hides roles, and advances after role confirmation', async t => {
  const port = await findFreePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'werewolf-gm-test-'));
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir },
    stdio: 'ignore'
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1500))]);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const headers = { 'Content-Type': 'application/json', Origin: 'https://example-user.github.io' };
  const createResponse = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST', headers, body: JSON.stringify({ name: 'Host' })
  });
  assert.equal(createResponse.status, 201);
  assert.equal(createResponse.headers.get('access-control-allow-origin'), 'https://example-user.github.io');
  const hostCreated = await createResponse.json();

  const recoverResponse = await fetch(`${baseUrl}/api/rooms/${hostCreated.code}/recover`, {
    method: 'POST', headers, body: JSON.stringify({ recoveryCode: hostCreated.recoveryCode })
  });
  assert.equal(recoverResponse.status, 200);
  const host = await recoverResponse.json();
  assert.notEqual(host.recoveryCode, hostCreated.recoveryCode);

  const oldTokenResponse = await fetch(`${baseUrl}/api/rooms/${host.code}/view`, {
    headers: { Origin: headers.Origin, Authorization: `Bearer ${hostCreated.token}` }
  });
  assert.equal(oldTokenResponse.status, 401, 'recovery must invalidate the previous session token');

  async function join(name) {
    const response = await fetch(`${baseUrl}/api/rooms/${host.code}/join`, {
      method: 'POST', headers, body: JSON.stringify({ name })
    });
    assert.equal(response.status, 201);
    return response.json();
  }
  const playerB = await join('Player B');
  const playerC = await join('Player C');

  async function command(session, command, payload = {}, phaseVersion) {
    const response = await fetch(`${baseUrl}/api/rooms/${host.code}/command`, {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ command, payload, ...(phaseVersion === undefined ? {} : { phaseVersion }) })
    });
    const body = await response.json();
    assert.equal(response.status, 200, body.error || `${command} failed`);
    return body;
  }

  const settings = {
    roles: { wolf: 1, seer: 0, medium: 0, madman: 0, villager: 2, knight: 0, teruteru: 0, fox: 0 },
    lovers: { enabled: false, pairCount: 0 }
  };
  await command(host, 'update_settings', { settings });
  await command(playerB, 'set_ready', { ready: true });
  await command(playerC, 'set_ready', { ready: true });
  await command(host, 'start_game');

  const sessions = [host, playerB, playerC];
  const views = await Promise.all(sessions.map(session => fetch(`${baseUrl}/api/rooms/${host.code}/view`, {
    headers: { Origin: headers.Origin, Authorization: `Bearer ${session.token}` }
  }).then(response => response.json())));

  for (let i = 0; i < views.length; i += 1) {
    assert.ok(views[i].game.myRole, 'each player receives their own role');
    assert.ok(views[i].players.every(player => player.role === undefined), 'no other role is exposed before the end');
    assert.equal(views[i].me.isHost, i === 0);
  }

  let finalView;
  for (let i = 0; i < sessions.length; i += 1) {
    const view = await fetch(`${baseUrl}/api/rooms/${host.code}/view`, {
      headers: { Origin: headers.Origin, Authorization: `Bearer ${sessions[i].token}` }
    }).then(response => response.json());
    finalView = await command(sessions[i], 'confirm_role', {}, view.game.phaseVersion);
  }
  assert.equal(finalView.game.phase, 'DAY_DISCUSSION');
});
