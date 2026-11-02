import { randomInt, randomUUID } from 'node:crypto';

export const ROLE_DEFINITIONS = {
  wolf: { id: 'wolf', name: '人狼', faction: 'wolf', action: '共同襲撃' },
  seer: { id: 'seer', name: '占い師', faction: 'village', action: '占い' },
  medium: { id: 'medium', name: '霊媒師', faction: 'village', action: '霊媒（自動）' },
  madman: { id: 'madman', name: '狂人', faction: 'wolf', action: 'なし' },
  villager: { id: 'villager', name: '市民', faction: 'village', action: 'なし' },
  knight: { id: 'knight', name: '騎士', faction: 'village', action: '護衛' },
  teruteru: { id: 'teruteru', name: 'てるてる', faction: 'independent', action: 'なし' },
  fox: { id: 'fox', name: '妖狐', faction: 'independent', action: 'なし' }
};

export const DEFAULT_SETTINGS = {
  version: 1,
  roles: { wolf: 2, seer: 1, medium: 1, madman: 1, villager: 2, knight: 1, teruteru: 1, fox: 1 },
  lovers: { enabled: true, pairCount: 1, followDeath: true, winAsLastPair: true },
  wolf: { killCount: 1, requireUnanimousApproval: true },
  knight: { consecutiveGuard: false, selfGuard: false },
  fox: { immuneToWolfAttack: true, diesByDivination: true },
  vote: { allowChange: true, tieRule: 'no_execution', maxRevotes: 1 },
  information: { revealRoleOnDeath: false, divinationResult: 'faction', mediumResult: 'faction' }
};

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function createGame(members, settingsInput = {}) {
  const settings = mergeSettings(settingsInput);
  const expected = Object.values(settings.roles).reduce((sum, n) => sum + Number(n || 0), 0);
  if (expected !== members.length) throw new Error(`役職の合計は参加人数（${members.length}人）と一致させてください。現在は${expected}人です。`);
  for (const [roleId, count] of Object.entries(settings.roles)) {
    if (!ROLE_DEFINITIONS[roleId]) throw new Error(`未対応の役職ID: ${roleId}`);
    if (!Number.isInteger(count) || count < 0 || count > members.length) throw new Error(`役職「${ROLE_DEFINITIONS[roleId].name}」の人数が不正です。`);
  }
  if (settings.roles.wolf < 1) throw new Error('人狼は最低1人必要です。');
  for (const uniqueRole of ['seer', 'knight', 'fox']) {
    if (settings.roles[uniqueRole] > 1) throw new Error(`${ROLE_DEFINITIONS[uniqueRole].name}は現在1人まで対応しています。`);
  }
  if (settings.lovers.enabled && members.length < 2) throw new Error('恋人を設定する場合は2人以上必要です。');
  if (settings.lovers.enabled && (!Number.isInteger(settings.lovers.pairCount) || settings.lovers.pairCount < 0 || settings.lovers.pairCount > Math.floor(members.length / 2))) throw new Error('恋人ペア数が参加人数に対して多すぎます。');
  if (!['no_execution', 'revote', 'random'].includes(settings.vote.tieRule)) throw new Error('同票ルールが不正です。');
  if (!Number.isInteger(settings.wolf.killCount) || settings.wolf.killCount < 1 || settings.wolf.killCount > 10) throw new Error('襲撃人数は1〜10人にしてください。');

  const deck = [];
  for (const [roleId, count] of Object.entries(settings.roles)) {
    for (let i = 0; i < count; i += 1) deck.push(roleId);
  }
  const shuffledRoles = shuffle(deck);
  const roles = {};
  const alive = {};
  const players = members.map((member, index) => {
    roles[member.id] = shuffledRoles[index];
    alive[member.id] = true;
    return { id: member.id, name: member.name, seat: member.seat };
  });
  const relationshipPairs = [];
  if (settings.lovers.enabled) {
    const count = Math.min(settings.lovers.pairCount, Math.floor(members.length / 2));
    const chosen = shuffle(members).slice(0, count * 2);
    for (let i = 0; i < chosen.length; i += 2) {
      relationshipPairs.push({ id: randomUUID(), type: 'lover', a: chosen[i].id, b: chosen[i + 1].id, active: true });
    }
  }
  return {
    id: randomUUID(), phase: 'ROLE_REVEAL', phaseVersion: 1,
    dayNumber: 1, nightNumber: 0, settings,
    players, roles, alive, relationships: relationshipPairs,
    roleConfirmed: {}, votes: {}, voteCandidates: null, voteRound: 0,
    actions: { wolfProposal: null, seer: null, knight: null },
    lastKnightGuardTarget: null, privateResults: {},
    events: [{ type: 'GAME_STARTED', at: new Date().toISOString(), data: { playerCount: members.length } }],
    winners: null, endedAt: null
  };
}

export function mergeSettings(input = {}) {
  const result = deepClone(DEFAULT_SETTINGS);
  for (const group of Object.keys(result)) {
    if (group === 'version') continue;
    if (input[group] && typeof input[group] === 'object') {
      if (group === 'roles') Object.assign(result.roles, input.roles);
      else Object.assign(result[group], input[group]);
    }
  }
  result.wolf.requireUnanimousApproval = true;
  result.version = 1;
  return result;
}

export function getAlivePlayers(game) {
  return game.players.filter(player => game.alive[player.id]);
}

export function roleName(roleId) {
  return ROLE_DEFINITIONS[roleId]?.name ?? '不明';
}

function addEvent(game, type, data = {}) {
  game.events.push({ type, at: new Date().toISOString(), data });
}

function getLover(game, playerId) {
  const pair = game.relationships.find(item => item.type === 'lover' && item.active && (item.a === playerId || item.b === playerId));
  if (!pair) return null;
  return pair.a === playerId ? pair.b : pair.a;
}

function killWithLoverChain(game, initialDeaths) {
  const deathMap = new Map();
  const queue = [...initialDeaths];
  while (queue.length) {
    const item = queue.shift();
    if (!item || !game.alive[item.playerId] || deathMap.has(item.playerId)) continue;
    deathMap.set(item.playerId, item.cause);
    if (game.settings.lovers.followDeath) {
      const partnerId = getLover(game, item.playerId);
      if (partnerId && game.alive[partnerId] && !deathMap.has(partnerId)) {
        queue.push({ playerId: partnerId, cause: 'lover_follow' });
      }
    }
  }
  for (const [playerId, cause] of deathMap.entries()) {
    game.alive[playerId] = false;
    addEvent(game, 'PLAYER_DIED', { playerId, cause });
  }
  return [...deathMap.entries()].map(([playerId, cause]) => ({ playerId, cause }));
}

function aliveRolePlayers(game, roleId) {
  return game.players.filter(player => game.alive[player.id] && game.roles[player.id] === roleId);
}

function expectedAttackCount(game) {
  const eligible = getAlivePlayers(game).filter(player => game.roles[player.id] !== 'wolf').length;
  return Math.min(game.settings.wolf.killCount, eligible);
}

function hasRequiredNightActions(game) {
  const wolves = aliveRolePlayers(game, 'wolf');
  if (wolves.length) {
    const proposal = game.actions.wolfProposal;
    if (!proposal || !wolves.every(player => proposal.approvedBy.includes(player.id))) return false;
  }
  if (aliveRolePlayers(game, 'seer').length && !game.actions.seer) return false;
  if (aliveRolePlayers(game, 'knight').length && !game.actions.knight) return false;
  return true;
}

function factionOf(roleId) {
  return ROLE_DEFINITIONS[roleId]?.faction ?? 'independent';
}

function storePrivateResult(game, playerId, result) {
  game.privateResults[playerId] ??= [];
  game.privateResults[playerId].push({ ...result, at: new Date().toISOString() });
}

function endGame(game, winners, reason) {
  game.phase = 'GAME_END';
  game.phaseVersion += 1;
  game.winners = { factions: winners, reason };
  game.endedAt = new Date().toISOString();
  addEvent(game, 'GAME_WON', game.winners);
}

export function checkVictory(game, trigger = 'normal') {
  if (game.phase === 'GAME_END') return true;
  const alive = getAlivePlayers(game);
  const aliveIds = new Set(alive.map(player => player.id));
  const wolfCount = alive.filter(player => game.roles[player.id] === 'wolf').length;
  const nonWolfCount = alive.length - wolfCount;

  const teruteruWinner = game.players.find(player => !game.alive[player.id] && game.roles[player.id] === 'teruteru' && game.events.some(event => event.type === 'PLAYER_DIED' && event.data.playerId === player.id && event.data.cause === 'executed'));
  if (teruteruWinner) {
    endGame(game, ['teruteru'], 'てるてるが投票で処刑された');
    return true;
  }

  if (game.settings.lovers.winAsLastPair) {
    const livingPairs = game.relationships.filter(pair => pair.type === 'lover' && pair.active && aliveIds.has(pair.a) && aliveIds.has(pair.b));
    if (livingPairs.some(pair => alive.length === 2 && aliveIds.has(pair.a) && aliveIds.has(pair.b))) {
      endGame(game, ['lovers'], '恋人2人だけが生存した');
      return true;
    }
  }

  const villageWon = wolfCount === 0;
  const wolfWon = wolfCount > 0 && wolfCount >= nonWolfCount;
  if (villageWon || wolfWon) {
    const foxAlive = alive.some(player => game.roles[player.id] === 'fox');
    if (foxAlive) endGame(game, ['fox'], '妖狐が生存したまま通常陣営の勝利条件が成立した');
    else endGame(game, [villageWon ? 'village' : 'wolf'], villageWon ? '生存中の人狼がいなくなった' : '人狼数がその他の生存者数以上になった');
    return true;
  }
  return false;
}

function enterPhase(game, phase) {
  game.phase = phase;
  game.phaseVersion += 1;
}

function resolveVote(game) {
  const alive = getAlivePlayers(game);
  const counts = new Map();
  for (const targetId of Object.values(game.votes)) counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  const maxVotes = Math.max(0, ...counts.values());
  const tied = [...counts.entries()].filter(([, count]) => count === maxVotes && count > 0).map(([id]) => id);
  let executedId = null;
  if (tied.length === 1) executedId = tied[0];
  else if (tied.length > 1) {
    const rule = game.settings.vote.tieRule;
    if (rule === 'random') executedId = tied[randomInt(tied.length)];
    else if (rule === 'revote' && game.voteRound < game.settings.vote.maxRevotes) {
      game.voteRound += 1;
      game.voteCandidates = tied;
      game.votes = {};
      addEvent(game, 'VOTE_REVOTE', { candidates: tied, round: game.voteRound });
      return { revote: true, candidates: tied };
    }
  }
  const tally = Object.fromEntries(counts.entries());
  addEvent(game, 'VOTE_RESOLVED', { tally, executedId, round: game.voteRound });
  if (executedId) {
    const deaths = killWithLoverChain(game, [{ playerId: executedId, cause: 'executed' }]);
    game.lastExecuted = { playerId: executedId, roleId: game.roles[executedId], faction: factionOf(game.roles[executedId]), dayNumber: game.dayNumber };
    return { revote: false, executedId, deaths };
  }
  game.lastExecuted = null;
  return { revote: false, executedId: null, deaths: [] };
}

function beginNight(game) {
  game.nightNumber += 1;
  game.actions = { wolfProposal: null, seer: null, knight: null };
  game.voteRound = 0;
  game.voteCandidates = null;
  enterPhase(game, 'NIGHT_ACTION');
  if (game.lastExecuted && aliveRolePlayers(game, 'medium').length) {
    for (const medium of aliveRolePlayers(game, 'medium')) {
      const result = game.settings.information.mediumResult === 'role'
        ? { type: 'medium', targetId: game.lastExecuted.playerId, roleId: game.lastExecuted.roleId, text: roleName(game.lastExecuted.roleId) }
        : { type: 'medium', targetId: game.lastExecuted.playerId, faction: game.lastExecuted.faction, text: game.lastExecuted.faction === 'wolf' ? '人狼陣営' : '人狼陣営以外' };
      storePrivateResult(game, medium.id, result);
    }
  }
}

function resolveNight(game) {
  const deaths = [];
  const proposal = game.actions.wolfProposal;
  const guardId = game.actions.knight?.targetId ?? null;
  const seerTargetId = game.actions.seer?.targetId ?? null;
  const foxId = game.players.find(player => game.alive[player.id] && game.roles[player.id] === 'fox')?.id ?? null;

  if (proposal) {
    for (const targetId of proposal.targetIds) {
      if (!game.alive[targetId]) continue;
      if (targetId === foxId && game.settings.fox.immuneToWolfAttack) {
        addEvent(game, 'WOLF_ATTACK_BLOCKED', { targetId, reason: 'fox_immunity' });
        continue;
      }
      if (targetId === guardId) {
        addEvent(game, 'PLAYER_PROTECTED', { targetId });
        continue;
      }
      deaths.push({ playerId: targetId, cause: 'wolf_attack' });
    }
  }

  if (seerTargetId && game.alive[seerTargetId]) {
    const roleId = game.roles[seerTargetId];
    const faction = factionOf(roleId);
    const result = game.settings.information.divinationResult === 'role'
      ? { type: 'divination', targetId: seerTargetId, roleId, text: roleName(roleId) }
      : { type: 'divination', targetId: seerTargetId, faction, text: faction === 'wolf' ? '人狼陣営' : '人狼陣営以外' };
    for (const seer of aliveRolePlayers(game, 'seer')) storePrivateResult(game, seer.id, result);
    if (roleId === 'fox' && game.settings.fox.diesByDivination) deaths.push({ playerId: seerTargetId, cause: 'divined' });
  }

  const uniqueDeaths = new Map();
  for (const death of deaths) {
    if (!uniqueDeaths.has(death.playerId)) uniqueDeaths.set(death.playerId, death.cause);
  }
  const resolvedDeaths = killWithLoverChain(game, [...uniqueDeaths.entries()].map(([playerId, cause]) => ({ playerId, cause })));
  game.lastNightResult = { deathIds: resolvedDeaths.map(item => item.playerId) };
  if (game.actions.knight?.targetId) game.lastKnightGuardTarget = game.actions.knight.targetId;
  addEvent(game, 'NIGHT_RESOLVED', { deaths: resolvedDeaths.map(item => item.playerId) });
  if (!checkVictory(game, 'night')) {
    game.dayNumber += 1;
    enterPhase(game, 'DAY_DISCUSSION');
  }
  return resolvedDeaths;
}

export function applyCommand(room, member, command, payload = {}) {
  const game = room.game;
  const isHost = member.isHost;
  const memberExists = room.members.some(item => item.id === member.id);
  if (!memberExists) throw new Error('ルーム参加者ではありません。');

  if (command === 'set_ready') {
    if (room.status !== 'LOBBY') throw new Error('ロビーではありません。');
    member.ready = Boolean(payload.ready);
    return;
  }
  if (command === 'update_settings') {
    if (!isHost || room.status !== 'LOBBY') throw new Error('設定を変更できません。');
    room.settings = mergeSettings(payload.settings ?? {});
    return;
  }
  if (command === 'start_game') {
    if (!isHost || room.status !== 'LOBBY') throw new Error('ゲームを開始できません。');
    if (room.members.length < 3) throw new Error('ゲーム開始には3人以上必要です。');
    if (room.members.some(item => !item.ready)) throw new Error('全員の準備が完了していません。');
    room.game = createGame(room.members, room.settings);
    room.status = 'IN_GAME';
    return;
  }
  if (!game || room.status !== 'IN_GAME') throw new Error('ゲームが開始されていません。');

  if (command === 'confirm_role') {
    if (game.phase !== 'ROLE_REVEAL') throw new Error('役職確認フェーズではありません。');
    game.roleConfirmed[member.id] = true;
    if (room.members.every(item => game.roleConfirmed[item.id])) enterPhase(game, 'DAY_DISCUSSION');
    return;
  }
  if (command === 'start_voting') {
    if (!isHost || game.phase !== 'DAY_DISCUSSION') throw new Error('投票を開始できません。');
    game.votes = {};
    game.voteRound = 0;
    game.voteCandidates = null;
    enterPhase(game, 'DAY_VOTE');
    return;
  }
  if (command === 'submit_vote') {
    if (game.phase !== 'DAY_VOTE') throw new Error('投票フェーズではありません。');
    if (!game.alive[member.id]) throw new Error('死亡者は投票できません。');
    const targetId = payload.targetId;
    if (!game.alive[targetId] || targetId === member.id) throw new Error('投票対象が不正です。');
    if (game.voteCandidates && !game.voteCandidates.includes(targetId)) throw new Error('再投票の対象外です。');
    if (!game.settings.vote.allowChange && game.votes[member.id]) throw new Error('投票は変更できません。');
    game.votes[member.id] = targetId;
    addEvent(game, 'VOTE_SUBMITTED', { voterId: member.id });
    if (getAlivePlayers(game).every(player => game.votes[player.id])) {
      const result = resolveVote(game);
      if (!result.revote) {
        game.lastDayResult = { executedId: result.executedId, deathIds: result.deaths.map(item => item.playerId) };
        if (!checkVictory(game, 'day')) beginNight(game);
      }
    }
    return;
  }
  if (command === 'propose_wolf_attack') {
    if (game.phase !== 'NIGHT_ACTION' || game.roles[member.id] !== 'wolf' || !game.alive[member.id]) throw new Error('襲撃提案を行えません。');
    if (game.actions.wolfProposal) throw new Error('現在の襲撃案が決着するまで、新しい案は提出できません。');
    const ids = Array.isArray(payload.targetIds) ? payload.targetIds : [];
    const killCount = expectedAttackCount(game);
    const livingWolves = aliveRolePlayers(game, 'wolf');
    if (ids.length !== killCount || new Set(ids).size !== ids.length) throw new Error(`現在の生存状況では襲撃対象を${killCount}人選択してください。`);
    for (const id of ids) {
      if (!game.alive[id] || game.roles[id] === 'wolf') throw new Error('襲撃対象が不正です。');
    }
    game.actions.wolfProposal = { targetIds: ids, proposerId: member.id, approvedBy: [member.id] };
    addEvent(game, 'WOLF_PROPOSAL', { proposerId: member.id });
    if (!game.settings.wolf.requireUnanimousApproval || livingWolves.length === 1) {
      if (hasRequiredNightActions(game)) resolveNight(game);
    }
    return;
  }
  if (command === 'wolf_vote') {
    const proposal = game.actions.wolfProposal;
    if (game.phase !== 'NIGHT_ACTION' || game.roles[member.id] !== 'wolf' || !game.alive[member.id] || !proposal) throw new Error('襲撃承認を行えません。');
    if (proposal.approvedBy.includes(member.id)) throw new Error('この襲撃案には既に承認済みです。');
    if (payload.approve !== true) {
      game.actions.wolfProposal = null;
      addEvent(game, 'WOLF_PROPOSAL_REJECTED', { playerId: member.id });
      return;
    }
    if (!proposal.approvedBy.includes(member.id)) proposal.approvedBy.push(member.id);
    if (hasRequiredNightActions(game)) resolveNight(game);
    return;
  }
  if (command === 'submit_seer' || command === 'submit_knight') {
    if (game.phase !== 'NIGHT_ACTION' || !game.alive[member.id]) throw new Error('夜の行動を行えません。');
    const expectedRole = command === 'submit_seer' ? 'seer' : 'knight';
    if (game.roles[member.id] !== expectedRole) throw new Error('この行動を行う役職ではありません。');
    if (game.actions[expectedRole]) throw new Error('この夜の行動は既に提出されています。');
    const targetId = payload.targetId;
    if (!game.alive[targetId] || targetId === member.id && !(expectedRole === 'knight' && game.settings.knight.selfGuard)) throw new Error('対象を選択できません。');
    if (expectedRole === 'knight' && !game.settings.knight.consecutiveGuard && game.lastKnightGuardTarget === targetId) throw new Error('前夜と同じ対象を連続して守ることはできません。');
    game.actions[expectedRole] = { actorId: member.id, targetId };
    addEvent(game, expectedRole === 'seer' ? 'DIVINATION_SUBMITTED' : 'GUARD_SUBMITTED', { actorId: member.id });
    if (hasRequiredNightActions(game)) resolveNight(game);
    return;
  }
  if (command === 'pause_game') {
    if (!isHost || !['DAY_DISCUSSION', 'DAY_VOTE', 'NIGHT_ACTION'].includes(game.phase)) throw new Error('一時停止できません。');
    game.pausedPhase = game.phase;
    enterPhase(game, 'PAUSED');
    addEvent(game, 'GAME_PAUSED');
    return;
  }
  if (command === 'resume_game') {
    if (!isHost || game.phase !== 'PAUSED' || !game.pausedPhase) throw new Error('再開できません。');
    const phase = game.pausedPhase;
    delete game.pausedPhase;
    enterPhase(game, phase);
    addEvent(game, 'GAME_RESUMED');
    return;
  }
  if (command === 'force_end') {
    if (!isHost || game.phase === 'GAME_END') throw new Error('ゲームを終了できません。');
    endGame(game, ['manual'], '主催者による強制終了');
    return;
  }
  throw new Error('未知のコマンドです。');
}

export function buildPlayerView(room, member) {
  const game = room.game;
  const publicPlayers = room.members.map(item => {
    const isAlive = game ? Boolean(game.alive[item.id]) : true;
    const reveal = game && (!isAlive && game.settings.information.revealRoleOnDeath || game.phase === 'GAME_END');
    return {
      id: item.id, name: item.name, seat: item.seat,
      isAlive,
      role: reveal ? game.roles[item.id] : undefined,
      roleName: reveal ? roleName(game.roles[item.id]) : undefined
    };
  });
  if (!game) {
    return { room: { code: room.code, status: room.status, settings: room.settings, hostMemberId: room.hostMemberId }, me: { id: member.id, name: member.name, isHost: member.isHost, ready: member.ready }, players: publicPlayers, game: null };
  }
  const roleId = game.roles[member.id];
  const partnerId = getLover(game, member.id);
  const wolfMates = roleId === 'wolf' ? aliveRolePlayers(game, 'wolf').filter(p => p.id !== member.id).map(p => ({ id: p.id, name: p.name })) : [];
  const alive = game.alive[member.id];
  const action = game.actions;
  const myAction = {
    voteTargetId: game.votes[member.id] ?? null,
    roleConfirmed: Boolean(game.roleConfirmed[member.id]),
    seerSubmitted: Boolean(action.seer?.actorId === member.id),
    knightSubmitted: Boolean(action.knight?.actorId === member.id),
    wolfProposal: roleId === 'wolf' && action.wolfProposal ? {
      targetNames: action.wolfProposal.targetIds.map(id => room.members.find(p => p.id === id)?.name ?? '不明'),
      approved: action.wolfProposal.approvedBy.includes(member.id),
      approvedCount: action.wolfProposal.approvedBy.length,
      totalWolves: aliveRolePlayers(game, 'wolf').length,
      proposedByMe: action.wolfProposal.proposerId === member.id
    } : null,
    privateResults: game.privateResults[member.id] ?? [],
    mediumResult: roleId === 'medium' && game.lastExecuted?.dayNumber === game.dayNumber ? (game.privateResults[member.id] ?? []).filter(result => result.type === 'medium').at(-1) ?? null : null
  };
  return {
    room: { code: room.code, status: room.status, hostMemberId: room.hostMemberId },
    me: { id: member.id, name: member.name, isHost: member.isHost, ready: member.ready, isAlive: alive },
    players: publicPlayers,
    game: {
      id: game.id, phase: game.phase, phaseVersion: game.phaseVersion,
      dayNumber: game.dayNumber, nightNumber: game.nightNumber,
      settings: game.settings,
      myRole: roleId ? { id: roleId, ...ROLE_DEFINITIONS[roleId] } : null,
      lover: partnerId ? { id: partnerId, name: room.members.find(p => p.id === partnerId)?.name ?? '不明' } : null,
      wolfMates,
      myAction,
      voteCount: Object.keys(game.votes).length,
      livingCount: getAlivePlayers(game).length,
      roleConfirmedCount: Object.keys(game.roleConfirmed).filter(id => game.roleConfirmed[id]).length,
      totalPlayerCount: game.players.length,
      revoteCandidates: game.voteCandidates,
      requiredAttackCount: expectedAttackCount(game),
      wolfProposalStatus: roleId === 'wolf' && action.wolfProposal ? { approvedCount: action.wolfProposal.approvedBy.length, totalWolves: aliveRolePlayers(game, 'wolf').length, targets: action.wolfProposal.targetIds.map(id => room.members.find(p => p.id === id)?.name ?? '不明') } : null,
      nightStatus: {
        wolvesDone: aliveRolePlayers(game, 'wolf').length === 0 || Boolean(action.wolfProposal && aliveRolePlayers(game, 'wolf').every(p => action.wolfProposal.approvedBy.includes(p.id))),
        seerDone: aliveRolePlayers(game, 'seer').length === 0 || Boolean(action.seer),
        knightDone: aliveRolePlayers(game, 'knight').length === 0 || Boolean(action.knight)
      },
      winners: game.winners,
      lastDayResult: game.lastDayResult ?? null,
      lastNightResult: game.lastNightResult ?? null,
      events: game.phase === 'GAME_END' ? game.events : game.events.filter(event => ['PLAYER_DIED', 'VOTE_RESOLVED', 'NIGHT_RESOLVED', 'GAME_PAUSED', 'GAME_RESUMED'].includes(event.type)).slice(-20).map(event => ({
        type: event.type,
        at: event.at,
        data: event.type === 'PLAYER_DIED' ? { playerId: event.data.playerId } : event.type === 'VOTE_RESOLVED' ? { executedId: event.data.executedId ?? null } : {}
      }))
    }
  };
}
