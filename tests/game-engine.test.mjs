import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, buildPlayerView, createGame, DEFAULT_SETTINGS, deepClone } from '../server/game-engine.mjs';

function members(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`, name: `Player${index + 1}`, seat: index + 1,
    isHost: index === 0, ready: true, tokenHash: `hash${index + 1}`
  }));
}
function settings(roles) {
  const copy = deepClone(DEFAULT_SETTINGS);
  copy.roles = { wolf: 0, seer: 0, medium: 0, madman: 0, knight: 0, villager: 0, teruteru: 0, fox: 0, ...roles };
  copy.lovers.enabled = false;
  return copy;
}
function makeRoom(count, roleCounts) {
  const people = members(count);
  const room = { code: 'ABC234', status: 'IN_GAME', members: people, settings: settings(roleCounts), game: createGame(people, settings(roleCounts)) };
  const roles = {};
  let cursor = 0;
  for (const [role, countForRole] of Object.entries(room.game.settings.roles)) {
    for (let i = 0; i < countForRole; i += 1) roles[people[cursor++].id] = role;
  }
  room.game.roles = roles;
  return room;
}
function command(room, memberIndex, action, payload = {}) {
  applyCommand(room, room.members[memberIndex], action, payload);
}

test('role distribution requires exact player count', () => {
  assert.throws(() => createGame(members(4), settings({ wolf: 1, villager: 2 })), /参加人数/);
});

test('player view reveals only own role before game end', () => {
  const room = makeRoom(3, { wolf: 1, villager: 2 });
  const view = buildPlayerView(room, room.members[0]);
  assert.equal(view.game.myRole.id, 'wolf');
  assert.equal(view.players[1].role, undefined);
  assert.equal(view.players[2].role, undefined);
});

test('all players confirm role before discussion begins', () => {
  const room = makeRoom(3, { wolf: 1, villager: 2 });
  room.game.phase = 'ROLE_REVEAL';
  command(room, 0, 'confirm_role');
  command(room, 1, 'confirm_role');
  assert.equal(room.game.phase, 'ROLE_REVEAL');
  command(room, 2, 'confirm_role');
  assert.equal(room.game.phase, 'DAY_DISCUSSION');
});

test('vote resolves and village wins when the last wolf is executed', () => {
  const room = makeRoom(4, { wolf: 1, villager: 3 });
  room.game.phase = 'DAY_VOTE';
  room.game.votes = {};
  command(room, 1, 'submit_vote', { targetId: 'p1' });
  command(room, 2, 'submit_vote', { targetId: 'p1' });
  command(room, 3, 'submit_vote', { targetId: 'p1' });
  command(room, 0, 'submit_vote', { targetId: 'p2' });
  assert.equal(room.game.phase, 'GAME_END');
  assert.deepEqual(room.game.winners.factions, ['village']);
  assert.equal(room.game.alive.p1, false);
});

test('knight protection blocks the wolf attack', () => {
  const room = makeRoom(5, { wolf: 1, seer: 1, knight: 1, villager: 2 });
  room.game.phase = 'NIGHT_ACTION';
  command(room, 0, 'propose_wolf_attack', { targetIds: ['p4'] });
  command(room, 1, 'submit_seer', { targetId: 'p5' });
  command(room, 4, 'submit_knight', { targetId: 'p4' });
  assert.equal(room.game.alive.p4, true);
  assert.equal(room.game.phase, 'DAY_DISCUSSION');
});

test('fox survives wolf attack but dies when divined', () => {
  const room = makeRoom(5, { wolf: 1, seer: 1, knight: 1, fox: 1, villager: 1 });
  room.game.phase = 'NIGHT_ACTION';
  command(room, 0, 'propose_wolf_attack', { targetIds: ['p5'] });
  command(room, 1, 'submit_seer', { targetId: 'p5' });
  command(room, 3, 'submit_knight', { targetId: 'p3' });
  assert.equal(room.game.alive.p5, false);
  assert.ok(room.game.events.some(event => event.type === 'PLAYER_DIED' && event.data.playerId === 'p5' && event.data.cause === 'divined'));
});

test('lover follows partner death exactly once', () => {
  const room = makeRoom(5, { wolf: 1, seer: 1, knight: 1, villager: 2 });
  room.game.phase = 'NIGHT_ACTION';
  room.game.relationships = [{ id: 'pair1', type: 'lover', a: 'p3', b: 'p4', active: true }];
  command(room, 0, 'propose_wolf_attack', { targetIds: ['p3'] });
  command(room, 1, 'submit_seer', { targetId: 'p4' });
  command(room, 4, 'submit_knight', { targetId: 'p2' });
  assert.equal(room.game.alive.p3, false);
  assert.equal(room.game.alive.p4, false);
  const deathEvents = room.game.events.filter(event => event.type === 'PLAYER_DIED' && ['p3', 'p4'].includes(event.data.playerId));
  assert.equal(deathEvents.length, 2);
});

test('teruteru wins when executed by a vote', () => {
  const room = makeRoom(4, { wolf: 1, teruteru: 1, villager: 2 });
  room.game.phase = 'DAY_VOTE';
  command(room, 0, 'submit_vote', { targetId: 'p4' });
  command(room, 1, 'submit_vote', { targetId: 'p4' });
  command(room, 2, 'submit_vote', { targetId: 'p4' });
  command(room, 3, 'submit_vote', { targetId: 'p1' });
  assert.equal(room.game.phase, 'GAME_END');
  assert.deepEqual(room.game.winners.factions, ['teruteru']);
});

test('multi-wolf attack waits for unanimous approval', () => {
  const room = makeRoom(4, { wolf: 2, villager: 2 });
  room.game.phase = 'NIGHT_ACTION';
  command(room, 0, 'propose_wolf_attack', { targetIds: ['p3'] });
  assert.equal(room.game.phase, 'NIGHT_ACTION');
  assert.equal(room.game.alive.p3, true);
  command(room, 1, 'wolf_vote', { approve: true });
  assert.equal(room.game.alive.p3, false);
  assert.equal(room.game.phase, 'GAME_END');
  assert.deepEqual(room.game.winners.factions, ['wolf']);
});

test('knight cannot guard the same target on consecutive nights when disabled', () => {
  const room = makeRoom(3, { wolf: 1, knight: 1, villager: 1 });
  room.game.phase = 'NIGHT_ACTION';
  room.game.lastKnightGuardTarget = 'p2';
  assert.throws(() => command(room, 2, 'submit_knight', { targetId: 'p2' }), /連続して守ることはできません/);
});

test('multiple seers are rejected until the engine supports independent actions', () => {
  assert.throws(() => createGame(members(4), settings({ wolf: 1, seer: 2, villager: 1 })), /占い師は現在1人まで/);
});

test('medium receives the faction of the previous execution privately', () => {
  const room = makeRoom(7, { wolf: 2, medium: 1, villager: 4 });
  room.game.phase = 'DAY_VOTE';
  command(room, 0, 'submit_vote', { targetId: 'p4' });
  command(room, 1, 'submit_vote', { targetId: 'p4' });
  command(room, 2, 'submit_vote', { targetId: 'p4' });
  command(room, 3, 'submit_vote', { targetId: 'p1' });
  command(room, 4, 'submit_vote', { targetId: 'p4' });
  command(room, 5, 'submit_vote', { targetId: 'p4' });
  command(room, 6, 'submit_vote', { targetId: 'p4' });
  assert.equal(room.game.phase, 'NIGHT_ACTION');
  const mediumView = buildPlayerView(room, room.members[2]);
  const villagerView = buildPlayerView(room, room.members[3]);
  assert.equal(mediumView.game.myAction.mediumResult.text, '人狼陣営以外');
  assert.equal(villagerView.game.myAction.mediumResult, null);
});
