(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const root = $('#app');
  const dialog = $('#settings-dialog');
  const toastEl = $('#toast');
  const connectionEl = $('#connection-status');
  const sessionPrefix = 'werewolf-gm-session:';
  const API_KEY = 'werewolf-gm-api-url';
  const roleNames = {
    wolf: '人狼', seer: '占い師', medium: '霊媒師', madman: '狂人',
    villager: '市民', knight: '騎士', teruteru: 'てるてる', fox: '妖狐'
  };
  const roleInfo = {
    wolf: { faction: '人狼陣営', icon: '🐺', description: '夜に人狼全員で襲撃先を決めます。人狼同士は互いを確認できます。' },
    seer: { faction: '村人陣営', icon: '🔮', description: '夜に生存者を1人選んで占います。妖狐を占った場合、妖狐は死亡します。' },
    medium: { faction: '村人陣営', icon: '🕯️', description: '昼に処刑されたプレイヤーの陣営または役職を、夜に確認できます。' },
    madman: { faction: '人狼陣営', icon: '🃏', description: '人狼陣営の一員です。人狼とは異なり、夜の襲撃には参加しません。' },
    villager: { faction: '村人陣営', icon: '👤', description: '特殊能力はありません。議論と投票を通じて人狼を見つけます。' },
    knight: { faction: '村人陣営', icon: '🛡️', description: '夜に生存者を1人護衛します。襲撃対象と一致した場合、その襲撃を防ぎます。' },
    teruteru: { faction: '独立陣営', icon: '☀️', description: '昼の投票で処刑されると、てるてるの勝利になります。' },
    fox: { faction: '独立陣営', icon: '🦊', description: '人狼の襲撃では死亡しません。占い師に占われると死亡します。' }
  };
  const factionNames = { village: '村人陣営', wolf: '人狼陣営', independent: '独立陣営', lovers: '恋人', fox: '妖狐', teruteru: 'てるてる', manual: '手動終了' };
  let apiBase = localStorage.getItem(API_KEY) || '';
  let currentCode = '';
  let currentToken = '';
  let currentRecoveryCode = '';
  let currentView = null;
  let pollTimer = null;
  let pollBusy = false;
  let toastTimer = null;
  let wolfTargetSelection = new Set();

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }
  function setConnection(online, label) {
    connectionEl.classList.toggle('online', Boolean(online));
    connectionEl.innerHTML = `<i></i>${esc(label || (online ? '接続中' : '未接続'))}`;
  }
  function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }
  function currentSession() {
    return currentCode && currentToken ? { code: currentCode, token: currentToken } : null;
  }
  function saveSession() {
    if (currentSession()) localStorage.setItem(sessionPrefix + currentCode, currentToken);
    if (currentCode && currentRecoveryCode) localStorage.setItem('werewolf-gm-recovery:' + currentCode, currentRecoveryCode);
    localStorage.setItem('werewolf-gm-last-room', currentCode);
  }
  function apiUrl(path) { return `${apiBase.replace(/\/$/, '')}${path}`; }

  async function request(path, options = {}) {
    if (!apiBase) throw new Error('先に接続設定からゲームサーバーURLを登録してください。');
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (currentToken) headers.Authorization = `Bearer ${currentToken}`;
    let response;
    try {
      response = await fetch(apiUrl(path), { ...options, headers, cache: 'no-store' });
    } catch {
      setConnection(false, '接続エラー');
      throw new Error('ゲームサーバーに接続できません。API URLとCodespacesの起動状態を確認してください。');
    }
    let data;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) throw new Error(data.error || `通信エラー（${response.status}）`);
    setConnection(true, '接続中');
    return data;
  }

  async function testConnection() {
    const result = $('#api-test-result');
    const input = $('#api-url');
    const value = input.value.trim().replace(/\/$/, '');
    if (!value) { result.textContent = 'URLを入力してください。'; return false; }
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('URL形式が正しくありません。');
      if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('公開サーバーにはHTTPSのURLを使用してください。');
      const response = await fetch(`${value}/api/health`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error('API応答を確認できません。');
      apiBase = value;
      localStorage.setItem(API_KEY, apiBase);
      result.textContent = '接続に成功しました。';
      result.style.color = '#82e1b8';
      setConnection(true, '接続可能');
      return true;
    } catch (error) {
      result.textContent = error.message || '接続できませんでした。';
      result.style.color = '#ffacb0';
      setConnection(false, '未接続');
      return false;
    }
  }

  function homeMarkup() {
    const connected = apiBase ? esc(apiBase) : '未設定';
    return `
      <section class="hero">
        <p class="eyebrow">DIGITAL GAME MASTER</p>
        <h1>WEREWOLF GM</h1>
        <p>議論はいつもの場所で。投票・夜の行動・死亡判定・勝利判定は、それぞれの端末で。</p>
      </section>
      <div class="message ${apiBase ? 'success' : 'info'}">${apiBase ? `接続先：${connected}` : '最初に接続設定から、CodespacesのAPI URLを登録してください。'}</div>
      <section class="home-grid">
        <article class="panel">
          <div class="panel-icon">＋</div>
          <h2>ルームを作成</h2>
          <p>新しいゲームを作成し、参加コードをほかのプレイヤーに共有します。</p>
          <form id="create-room-form">
            <label class="field"><span class="field-label">あなたのプレイヤー名</span><input class="text-input" name="name" maxlength="16" required placeholder="例：プレイヤーA"></label>
            <button class="button button-primary button-block" type="submit">ルームを作成する</button>
          </form>
        </article>
        <article class="panel">
          <div class="panel-icon">⇥</div>
          <h2>ルームに参加</h2>
          <p>主催者から共有された6文字のルームコードを入力します。</p>
          <form id="join-room-form">
            <label class="field"><span class="field-label">あなたのプレイヤー名</span><input class="text-input" name="name" maxlength="16" required placeholder="例：プレイヤーB"></label>
            <label class="field"><span class="field-label">ルームコード</span><input class="text-input" name="code" maxlength="6" required placeholder="例：A8K3Q2" style="text-transform:uppercase;letter-spacing:.15em"></label>
            <button class="button button-secondary button-block" type="submit">ルームに参加する</button>
          </form>
        </article>
        <article class="panel">
          <div class="panel-icon">↻</div>
          <h2>プレイヤーとして復帰</h2>
          <p>同じプレイヤー名・参加枠で再接続します。以前に発行した復帰コードが必要です。</p>
          <form id="recover-room-form">
            <label class="field"><span class="field-label">ルームコード</span><input class="text-input" name="code" maxlength="6" required placeholder="6文字のコード" style="text-transform:uppercase;letter-spacing:.15em"></label>
            <label class="field"><span class="field-label">復帰コード</span><input class="text-input" name="recoveryCode" maxlength="12" required placeholder="12文字の復帰コード" style="text-transform:uppercase;letter-spacing:.12em"></label>
            <button class="button button-secondary button-block" type="submit">元のプレイヤー枠に復帰</button>
          </form>
        </article>
      </section>
      <section class="panel" style="max-width:680px;margin:0 auto">
        <div class="section-title"><h2>このMVPについて</h2><span class="pill blue">v0.1.0</span></div>
        <p>初期対応：人狼・占い師・霊媒師・狂人・市民・騎士・てるてる・妖狐、および恋人属性。主催者もプレイヤーとして参加できます。</p>
        <p class="hint">注意：ゲームデータはCodespaces内に保存されます。Codespacesの停止中はゲームに参加できません。ゲーム終了後は、必要な記録を保存してからCodespaceを停止してください。</p>
      </section>`;
  }

  function renderHome() {
    stopPolling();
    $('#recovery-toggle').hidden = true;
    currentView = null;
    root.innerHTML = homeMarkup();
    setConnection(false, apiBase ? '接続先設定済み' : '未接続');
  }

  function renderPlayerList(view, showReady = false) {
    return `<div class="player-list">${view.players.map(player => `
      <div class="player-row">
        <div class="player-ident"><span class="seat">${esc(player.seat)}</span><div><div class="player-name">${esc(player.name)} ${view.me.id === player.id ? '<span class="muted">（あなた）</span>' : ''} ${player.id === view.room.hostMemberId ? '<span class="muted">・主催者</span>' : ''}</div>${player.roleName ? `<div class="player-meta">${esc(player.roleName)}</div>` : ''}</div></div>
        <div>${player.isAlive === false ? '<span class="pill bad">死亡</span>' : showReady ? (player.ready ? '<span class="pill good">準備完了</span>' : '<span class="pill warn">未準備</span>') : '<span class="pill good">生存</span>'}</div>
      </div>`).join('')}</div>`;
  }

  function lobbySettingsMarkup(settings) {
    const roleInputs = Object.entries(roleNames).map(([id, name]) => `
      <div class="setting-item"><label for="role-${id}">${name}</label><input id="role-${id}" data-role-count="${id}" type="number" min="0" max="${['seer','knight','fox'].includes(id) ? 1 : 20}" value="${Number(settings.roles[id] || 0)}"></div>`).join('');
    return `<details class="panel" id="game-settings-panel" ${viewIsHost() ? '' : 'hidden'}>
      <summary style="cursor:pointer;font-weight:800;font-size:14px">ゲーム設定を編集</summary>
      <p class="hint">役職人数の合計と参加人数を一致させてください。恋人は通常役職とは別に2人へ付与されます。</p>
      <div class="settings-grid" style="margin-top:14px">${roleInputs}</div>
      <div class="spacer"></div>
      <div class="settings-grid">
        <div class="setting-item"><label for="setting-kills">人狼の襲撃人数</label><input id="setting-kills" type="number" min="1" max="5" value="${settings.wolf.killCount}"></div>
        <div class="setting-item"><label for="setting-pairs">恋人ペア数</label><input id="setting-pairs" type="number" min="0" max="5" value="${settings.lovers.pairCount}"></div>
        <div class="setting-item"><label for="setting-tie">同票時の処理</label><select id="setting-tie"><option value="no_execution" ${settings.vote.tieRule === 'no_execution' ? 'selected' : ''}>処刑なし</option><option value="revote" ${settings.vote.tieRule === 'revote' ? 'selected' : ''}>再投票（最大1回）</option><option value="random" ${settings.vote.tieRule === 'random' ? 'selected' : ''}>同票者からランダム</option></select></div>
        <div class="setting-item"><label for="setting-divination">占い結果</label><select id="setting-divination"><option value="faction" ${settings.information.divinationResult === 'faction' ? 'selected' : ''}>陣営判定</option><option value="role" ${settings.information.divinationResult === 'role' ? 'selected' : ''}>役職判定</option></select></div>
        <div class="setting-item"><label for="setting-medium">霊媒結果</label><select id="setting-medium"><option value="faction" ${settings.information.mediumResult === 'faction' ? 'selected' : ''}>陣営判定</option><option value="role" ${settings.information.mediumResult === 'role' ? 'selected' : ''}>役職判定</option></select></div>
      </div>
      <label class="checkbox-line"><input id="setting-guard-chain" type="checkbox" ${settings.knight.consecutiveGuard ? 'checked' : ''}>騎士の連続護衛を許可</label>
      <label class="checkbox-line"><input id="setting-self-guard" type="checkbox" ${settings.knight.selfGuard ? 'checked' : ''}>騎士の自己護衛を許可</label>
      <label class="checkbox-line"><input id="setting-lover-enabled" type="checkbox" ${settings.lovers.enabled ? 'checked' : ''}>恋人ペアを作成する</label>
      <label class="checkbox-line"><input id="setting-lover-follow" type="checkbox" ${settings.lovers.followDeath ? 'checked' : ''}>恋人の片方が死亡すると相方も後追いする</label>
      <label class="checkbox-line"><input id="setting-lover-win" type="checkbox" ${settings.lovers.winAsLastPair ? 'checked' : ''}>恋人2人だけが生存した場合に勝利</label>
      <label class="checkbox-line"><input id="setting-fox-immune" type="checkbox" ${settings.fox.immuneToWolfAttack ? 'checked' : ''}>妖狐は人狼の襲撃で死亡しない</label>
      <label class="checkbox-line"><input id="setting-fox-divine" type="checkbox" ${settings.fox.diesByDivination ? 'checked' : ''}>妖狐は占われると死亡する</label>
      <label class="checkbox-line"><input id="setting-vote-change" type="checkbox" ${settings.vote.allowChange ? 'checked' : ''}>投票の変更を許可</label>
      <label class="checkbox-line"><input id="setting-role-reveal" type="checkbox" ${settings.information.revealRoleOnDeath ? 'checked' : ''}>死亡時に役職を公開</label>
      <div class="button-row" style="margin-top:15px"><button class="button button-primary" data-action="save-settings">設定を保存</button></div>
    </details>`;
  }

  let renderingView = null;
  function viewIsHost() { return Boolean(renderingView?.me?.isHost); }

  function renderLobby(view) {
    const settings = view.room.settings;
    const roleTotal = Object.values(settings.roles).reduce((a, b) => a + Number(b || 0), 0);
    const allReady = view.players.every(player => player.ready);
    root.innerHTML = `
      <div class="page-heading"><div><p class="eyebrow">GAME LOBBY</p><h1>ロビー</h1><p>参加者が揃ったら、役職構成を確認してゲームを開始します。</p></div><div class="room-code"><span>${esc(view.room.code)}</span><button data-action="copy-code">コピー</button></div></div>
      <div class="grid-two">
        <section class="panel"><div class="section-title"><h2>参加者</h2><span class="count">${view.players.length} / 20人</span></div>${renderPlayerList(view, true)}<div class="spacer"></div><button class="button ${view.me.ready ? 'button-secondary' : 'button-primary'} button-block" data-action="toggle-ready">${view.me.ready ? '準備を取り消す' : '準備完了にする'}</button><p class="hint">主催者もプレイヤーとして準備状態を設定します。</p></section>
        <section class="panel"><div class="section-title"><h2>開始条件</h2><span class="pill ${allReady ? 'good' : 'warn'}">${allReady ? '準備完了' : '待機中'}</span></div>
          <div class="result-list"><div class="result-item"><span>役職人数</span><strong>${roleTotal}人</strong></div><div class="result-item"><span>参加人数</span><strong>${view.players.length}人</strong></div><div class="result-item"><span>恋人</span><strong>${settings.lovers.enabled ? `${settings.lovers.pairCount}組` : 'なし'}</strong></div><div class="result-item"><span>襲撃人数</span><strong>${settings.wolf.killCount}人</strong></div></div>
          <p class="hint">役職人数の合計と参加人数が一致し、全員が準備完了になると開始できます。</p>
          ${view.me.isHost ? `<button class="button button-primary button-block" data-action="start-game" ${!allReady || roleTotal !== view.players.length ? 'disabled' : ''}>ゲーム開始</button>` : '<div class="message info">主催者が設定と準備状況を確認しています。</div>'}
        </section>
      </div>
      ${lobbySettingsMarkup(settings)}`;
  }

  function renderRoleReveal(view) {
    const role = view.game.myRole;
    const info = roleInfo[role.id] || { faction: role.faction, icon: '◆', description: role.action };
    const allies = view.game.wolfMates.length ? `<div class="message info">人狼の仲間：${view.game.wolfMates.map(item => esc(item.name)).join('、')}</div>` : '';
    const lover = view.game.lover ? `<div class="message info">あなたの恋人：${esc(view.game.lover.name)}</div>` : '';
    root.innerHTML = `
      <div class="page-heading"><div><p class="eyebrow">ROLE REVEAL</p><h1>役職確認</h1><p>自分の役職と能力を確認してください。他人に画面を見られないよう注意してください。</p></div><div class="room-code"><span>${esc(view.room.code)}</span></div></div>
      <section class="panel"><div class="role-card"><div class="role-symbol">${info.icon}</div><p class="eyebrow">YOUR ROLE</p><h2>${esc(role.name)}</h2><div class="faction">${esc(info.faction)}</div><p class="description">${esc(info.description)}</p></div>${allies}${lover}<div class="message info">役職確認済み：${view.game.roleConfirmedCount} / ${view.game.totalPlayerCount}人</div><button class="button button-primary button-block" data-action="confirm-role" ${view.game.myAction.roleConfirmed ? 'disabled' : ''}>${view.game.myAction.roleConfirmed ? '確認済み・他のプレイヤーを待っています' : '確認しました'}</button></section>`;
  }

  function renderVote(view) {
    const game = view.game;
    const alive = view.players.filter(player => player.isAlive && player.id !== view.me.id && (!game.revoteCandidates || game.revoteCandidates.includes(player.id)));
    const already = Boolean(game.myAction.voteTargetId);
    const canChange = game.settings.vote.allowChange;
    const disabled = !view.me.isAlive || (already && !canChange);
    return `
      <section class="phase-banner"><div><p>DAY ${game.dayNumber}</p><h2>投票フェーズ</h2><p>${game.revoteCandidates ? '同票者を対象に再投票します。' : '議論を終え、処刑する相手を選択してください。'}</p></div><span class="pill warn">投票 ${game.voteCount} / ${game.livingCount}</span></section>
      <div class="grid-two"><section class="panel"><div class="section-title"><h2>投票先</h2><span class="count">生存者から1人</span></div>
        ${view.me.isAlive ? `<label class="field"><span class="field-label">投票するプレイヤー</span><select id="vote-target" class="select-input" ${disabled ? 'disabled' : ''}><option value="">選択してください</option>${alive.map(player => `<option value="${esc(player.id)}" ${game.myAction.voteTargetId === player.id ? 'selected' : ''}>${esc(player.name)}</option>`).join('')}</select></label>
        <button class="button button-primary button-block" data-action="submit-vote" ${disabled ? 'disabled' : ''}>${already ? (canChange ? '投票先を変更する' : '投票済み') : '投票を確定する'}</button>
        ${already ? '<div class="message success">投票を受け付けました。ほかのプレイヤーの投票を待っています。</div>' : ''}` : '<div class="message info">死亡しているため投票できません。</div>'}
        <p class="hint">投票先は全員の投票完了まで他のプレイヤーには公開されません。</p>
      </section><section class="panel"><h2>投票状況</h2><div class="status-grid"><div class="status-tile"><strong>${game.voteCount}</strong><span>投票済み</span></div><div class="status-tile"><strong>${game.livingCount}</strong><span>投票対象人数を含む生存人数</span></div><div class="status-tile"><strong>${game.livingCount - game.voteCount}</strong><span>未投票人数</span></div></div>${view.me.isHost ? '<p class="hint">全員の投票が完了すると自動で集計されます。</p>' : ''}</section></div>`;
  }

  function renderNight(view) {
    const game = view.game;
    const me = view.me;
    const roleId = game.myRole.id;
    const aliveTargets = view.players.filter(player => player.isAlive && player.id !== me.id);
    const wolfTargets = aliveTargets.filter(player => !game.myRole || game.myRole.id !== 'wolf' || !game.wolfMates.some(wolf => wolf.id === player.id));
    let actionHtml = '';
    if (!me.isAlive) {
      actionHtml = '<div class="message info">あなたは死亡しています。夜の行動には参加できません。</div>';
    } else if (roleId === 'wolf') {
      const proposal = game.myAction.wolfProposal;
      if (proposal) {
        actionHtml = `<div class="message info">襲撃候補：${proposal.targetNames.map(esc).join('、')}<br>承認：${proposal.approvedCount} / ${proposal.totalWolves}人</div>${proposal.approved ? '<div class="message success">あなたはこの襲撃案を承認しています。</div>' : `<div class="button-row"><button class="button button-primary" data-action="wolf-approve">この襲撃案を承認</button><button class="button button-danger" data-action="wolf-reject">反対して提案を取り消す</button></div>`}<p class="hint">人狼全員の承認が揃うと、襲撃先が確定します。</p>`;
      } else {
        const selectedCount = wolfTargetSelection.size;
        const requiredCount = game.requiredAttackCount;
        actionHtml = `<h3>襲撃対象を選択</h3><p>人狼全員で襲撃先を決めます。現在の生存状況では${requiredCount}人選択してください。</p><div class="check-list">${wolfTargets.map(player => `<label class="check-option"><input type="checkbox" data-wolf-target="${esc(player.id)}" ${wolfTargetSelection.has(player.id) ? 'checked' : ''}>${esc(player.name)}${game.myRole && view.game.wolfMates.some(w => w.id === player.id) ? '（仲間）' : ''}</label>`).join('')}</div><div class="button-row"><button class="button button-primary" data-action="wolf-propose" ${selectedCount !== requiredCount ? 'disabled' : ''}>襲撃案を提案（${selectedCount}/${requiredCount}）</button></div>`;
      }
    } else if (roleId === 'seer' || roleId === 'knight') {
      const isSeer = roleId === 'seer';
      const submitted = isSeer ? game.myAction.seerSubmitted : game.myAction.knightSubmitted;
      const title = isSeer ? '占い対象を選択' : '護衛対象を選択';
      const action = isSeer ? 'submit-seer' : 'submit-knight';
      const targets = view.players.filter(player => player.isAlive && (isSeer ? player.id !== me.id : (game.settings.knight.selfGuard || player.id !== me.id)));
      actionHtml = submitted ? '<div class="message success">夜の行動を登録しました。他の行動が完了するまでお待ちください。</div>' : `<h3>${title}</h3><label class="field"><span class="field-label">対象プレイヤー</span><select class="select-input" id="night-target"><option value="">選択してください</option>${targets.map(player => `<option value="${esc(player.id)}">${esc(player.name)}</option>`).join('')}</select></label><button class="button button-primary button-block" data-action="${action}">行動を確定する</button>`;
    } else if (roleId === 'medium') {
      const result = game.myAction.mediumResult;
      actionHtml = result ? `<div class="message success">霊媒結果：${esc(result.text)}<br>対象：${esc(view.players.find(p => p.id === result.targetId)?.name || '処刑者')}</div>` : '<div class="message info">今回確認できる処刑者はいません。</div>';
    } else {
      actionHtml = '<div class="message info">あなたの役職には夜の行動がありません。朝になるまでお待ちください。</div>';
    }
    const results = game.myAction.privateResults.filter(result => result.type === 'divination');
    const resultMarkup = results.length ? `<div class="action-box"><h3>占い履歴（本人のみ）</h3>${results.slice(-5).map(result => `<div class="result-item"><span>${esc(view.players.find(p => p.id === result.targetId)?.name || '対象者')}</span><strong>${esc(result.text)}</strong></div>`).join('')}</div>` : '';
    const executedName = game.lastDayResult?.executedId ? view.players.find(player => player.id === game.lastDayResult.executedId)?.name : null;
    const dayResultMarkup = game.lastDayResult ? `<div class="message info">前回の投票結果：${executedName ? `${esc(executedName)}が処刑されました。` : '処刑者はいません。'}${game.lastDayResult.deathIds?.length > 1 ? ` 後追いを含む死亡者：${game.lastDayResult.deathIds.map(id => esc(view.players.find(p => p.id === id)?.name || 'プレイヤー')).join('、')}` : ''}</div>` : '';
    root.innerHTML = `
      ${dayResultMarkup}
      <section class="phase-banner night"><div><p>NIGHT ${game.nightNumber}</p><h2>夜の行動</h2><p>必要な行動が全て完了すると、夜の処理が自動で実行されます。</p></div><span class="pill warn">夜フェーズ</span></section>
      <div class="grid-two"><section class="panel"><div class="section-title"><h2>${esc(game.myRole.name)}の行動</h2><span class="pill blue">個人画面</span></div><div class="action-box">${actionHtml}</div>${resultMarkup}</section>
      <section class="panel"><h2>夜の進行状況</h2><div class="status-grid" style="grid-template-columns:1fr">${[['人狼の襲撃',game.nightStatus.wolvesDone],['占い師の占い',game.nightStatus.seerDone],['騎士の護衛',game.nightStatus.knightDone]].map(([label,done]) => `<div class="status-tile"><strong>${label}</strong><span>${done ? '行動完了' : '行動待ち'}</span></div>`).join('')}</div><p class="hint">自分に関係のない役職の行動状況は、完了・待機のみ表示されます。対象者や結果は表示されません。</p></section></div>`;
  }

  function renderGameEnd(view) {
    const game = view.game;
    const winners = game.winners?.factions || [];
    const winnerNames = winners.map(id => factionNames[id] || id).join('・');
    const roles = view.players.map(player => `<div class="player-row"><div class="player-ident"><span class="seat">${esc(player.seat)}</span><span class="player-name">${esc(player.name)}</span></div><div><span class="pill blue">${esc(player.roleName || roleNames[player.role] || '役職不明')}</span></div></div>`).join('');
    const relationshipRows = view.game.myRole ? '' : '';
    const eventRows = (game.events || []).slice(-30).map(event => {
      const data = event.data || {};
      const player = view.players.find(item => item.id === data.playerId || item.id === data.executedId || item.id === data.targetId);
      const label = event.type === 'PLAYER_DIED' ? `${player?.name || 'プレイヤー'}が死亡` : event.type === 'VOTE_RESOLVED' ? (data.executedId ? `${view.players.find(p => p.id === data.executedId)?.name || 'プレイヤー'}が処刑` : '投票の結果、処刑なし') : event.type === 'NIGHT_RESOLVED' ? '夜の処理が完了' : event.type;
      return `<div class="result-item"><span>${esc(label)}</span><small>${new Date(event.at).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}</small></div>`;
    }).join('');
    root.innerHTML = `
      <section class="winner"><div class="trophy">🏆</div><p class="eyebrow">GAME FINISHED</p><h1>${esc(winnerNames || 'ゲーム終了')}</h1><p>${esc(game.winners?.reason || '')}</p></section>
      <div class="grid-two" style="margin-top:16px"><section class="panel"><div class="section-title"><h2>最終役職一覧</h2><span class="count">${view.players.length}人</span></div><div class="player-list">${roles}</div></section><section class="panel"><h2>ゲーム履歴</h2><div class="result-list">${eventRows || '<p class="muted">履歴はありません。</p>'}</div></section></div>
      <div class="button-row" style="margin-top:16px"><button class="button button-secondary" data-action="copy-summary">結果をコピー</button><button class="button button-ghost" data-action="back-home">トップへ戻る</button></div>`;
  }

  function renderPaused(view) {
    root.innerHTML = `<section class="panel" style="text-align:center;padding:38px 22px"><p class="eyebrow">GAME PAUSED</p><h1>ゲームを一時停止中</h1><p class="muted">主催者が再開するまで、行動や投票はできません。</p>${view.me.isHost ? '<button class="button button-primary" data-action="resume-game">ゲームを再開する</button>' : ''}</section>`;
  }

  function renderGame(view) {
    const phase = view.game.phase;
    if (phase === 'ROLE_REVEAL') return renderRoleReveal(view);
    if (phase === 'DAY_DISCUSSION') {
      const nightDeaths = view.game.lastNightResult?.deathIds || [];
      const nightNames = nightDeaths.map(id => view.players.find(player => player.id === id)?.name || 'プレイヤー');
      const dawnMessage = view.game.dayNumber > 1 ? `<div class="message ${nightNames.length ? 'error' : 'success'}">${nightNames.length ? `昨夜の死亡者：${nightNames.map(esc).join('、')}` : '昨夜の死亡者はいません。'}</div>` : '';
      root.innerHTML = `${dawnMessage}<section class="phase-banner"><div><p>DAY ${view.game.dayNumber}</p><h2>昼・議論</h2><p>議論は現実で行ってください。終了したら主催者が投票を開始します。</p></div><span class="pill blue">議論フェーズ</span></section>
        <div class="grid-two"><section class="panel"><div class="section-title"><h2>生存者</h2><span class="count">${view.game.livingCount}人</span></div>${renderPlayerList(view)}</section><section class="panel"><h2>進行操作</h2><p>議論が終了したら投票フェーズに切り替えます。</p>${view.me.isHost ? '<button class="button button-primary button-block" data-action="start-voting">投票を開始する</button>' : '<div class="message info">主催者が議論終了を確認しています。</div>'}</section></div>`;
    } else if (phase === 'DAY_VOTE') renderVote(view);
    else if (phase === 'NIGHT_ACTION') renderNight(view);
    else if (phase === 'GAME_END') return renderGameEnd(view);
    else if (phase === 'PAUSED') return renderPaused(view);
    else {
      root.innerHTML = `<section class="panel"><h2>処理中</h2><p class="muted">ゲーム状態を同期しています。</p></section>`;
    }
    if (view.me.isHost && !['GAME_END','PAUSED'].includes(phase)) {
      root.insertAdjacentHTML('beforeend', `<div class="button-row" style="margin-top:15px"><button class="button button-ghost" data-action="pause-game">一時停止</button><button class="button button-danger" data-action="force-end">ゲームを強制終了</button></div>`);
    }
  }

  function renderRoom(view) {
    $('#recovery-toggle').hidden = false;
    renderingView = view;
    currentView = view;
    if (!view.game) return renderLobby(view);
    return renderGame(view);
  }

  async function refreshView(silent = false) {
    if (!currentCode || !currentToken || pollBusy) return;
    pollBusy = true;
    try {
      const view = await request(`/api/rooms/${currentCode}/view`, { method: 'GET', headers: {} });
      const old = currentView ? JSON.stringify(currentView) : '';
      const next = JSON.stringify(view);
      if (old !== next) {
        wolfTargetSelection.clear();
        renderRoom(view);
      }
      setConnection(true, '接続中');
      return true;
    } catch (error) {
      if (!silent) showToast(error.message);
      setConnection(false, '再接続待ち');
      return false;
    } finally {
      pollBusy = false;
    }
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => refreshView(true), 1800);
  }

  async function enterRoom(code, token, recoveryCode = '') {
    currentCode = code;
    currentToken = token;
    currentRecoveryCode = recoveryCode || localStorage.getItem('werewolf-gm-recovery:' + code) || '';
    saveSession();
    const params = new URLSearchParams(location.search);
    params.set('room', code);
    history.replaceState({}, '', `${location.pathname}?${params.toString()}`);
    root.innerHTML = '<section class="loading-panel"><div class="spinner"></div><p>ルームに接続しています…</p></section>';
    const connected = await refreshView(false);
    if (!connected) {
      stopPolling();
      currentCode = ''; currentToken = ''; currentRecoveryCode = '';
      renderHome();
      return false;
    }
    startPolling();
    return true;
  }

  async function sendCommand(command, payload = {}) {
    if (!currentView) return;
    const body = { command, payload };
    if (currentView.game) body.phaseVersion = currentView.game.phaseVersion;
    try {
      const view = await request(`/api/rooms/${currentCode}/command`, { method: 'POST', body: JSON.stringify(body) });
      wolfTargetSelection.clear();
      renderRoom(view);
      return view;
    } catch (error) {
      showToast(error.message);
      await refreshView(true);
      return null;
    }
  }

  function collectSettings() {
    const previous = currentView.room.settings;
    const roles = { ...previous.roles };
    document.querySelectorAll('[data-role-count]').forEach(input => { roles[input.dataset.roleCount] = Number(input.value); });
    const values = {
      roles,
      wolf: { ...previous.wolf, killCount: Number($('#setting-kills').value), requireUnanimousApproval: true },
      knight: { consecutiveGuard: $('#setting-guard-chain').checked, selfGuard: $('#setting-self-guard').checked },
      lovers: { enabled: $('#setting-lover-enabled').checked, pairCount: Number($('#setting-pairs').value), followDeath: $('#setting-lover-follow').checked, winAsLastPair: $('#setting-lover-win').checked },
      fox: { immuneToWolfAttack: $('#setting-fox-immune').checked, diesByDivination: $('#setting-fox-divine').checked },
      vote: { allowChange: $('#setting-vote-change').checked, tieRule: $('#setting-tie').value, maxRevotes: 1 },
      information: { revealRoleOnDeath: $('#setting-role-reveal').checked, divinationResult: $('#setting-divination').value, mediumResult: $('#setting-medium').value }
    };
    return values;
  }

  root.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    try {
      if (form.id === 'create-room-form') {
        const name = String(data.get('name') || '').trim();
        const result = await request('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) });
        await enterRoom(result.code, result.token, result.recoveryCode);
        showToast(`ルーム ${result.code} を作成しました。`);
      }
      if (form.id === 'join-room-form') {
        const name = String(data.get('name') || '').trim();
        const code = String(data.get('code') || '').trim().toUpperCase();
        const result = await request(`/api/rooms/${code}/join`, { method: 'POST', body: JSON.stringify({ name }) });
        await enterRoom(result.code, result.token, result.recoveryCode);
        showToast('ルームに参加しました。');
      }
      if (form.id === 'recover-room-form') {
        const code = String(data.get('code') || '').trim().toUpperCase();
        const recoveryCode = String(data.get('recoveryCode') || '').trim().toUpperCase();
        const result = await request(`/api/rooms/${code}/recover`, { method: 'POST', body: JSON.stringify({ recoveryCode }) });
        await enterRoom(result.code, result.token, result.recoveryCode);
        showToast('元のプレイヤー枠に復帰しました。新しい復帰コードを保管してください。');
      }
    } catch (error) { showToast(error.message); }
  });

  root.addEventListener('change', event => {
    const target = event.target;
    if (target.matches('[data-wolf-target]')) {
      const id = target.dataset.wolfTarget;
      if (target.checked) wolfTargetSelection.add(id); else wolfTargetSelection.delete(id);
      const button = root.querySelector('[data-action="wolf-propose"]');
      if (button && currentView) {
        const max = currentView.game.requiredAttackCount;
        button.disabled = wolfTargetSelection.size !== max;
        button.textContent = `襲撃案を提案（${wolfTargetSelection.size}/${max}）`;
      }
    }
  });

  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'toggle-ready') return sendCommand('set_ready', { ready: !currentView.me.ready });
    if (action === 'start-game') return sendCommand('start_game');
    if (action === 'confirm-role') return sendCommand('confirm_role');
    if (action === 'start-voting') return sendCommand('start_voting');
    if (action === 'submit-vote') {
      const targetId = $('#vote-target')?.value;
      if (!targetId) return showToast('投票先を選択してください。');
      return sendCommand('submit_vote', { targetId });
    }
    if (action === 'save-settings') {
      const settings = collectSettings();
      return sendCommand('update_settings', { settings });
    }
    if (action === 'wolf-propose') return sendCommand('propose_wolf_attack', { targetIds: [...wolfTargetSelection] });
    if (action === 'wolf-approve') return sendCommand('wolf_vote', { approve: true });
    if (action === 'wolf-reject') return sendCommand('wolf_vote', { approve: false });
    if (action === 'submit-seer' || action === 'submit-knight') {
      const targetId = $('#night-target')?.value;
      if (!targetId) return showToast('対象を選択してください。');
      return sendCommand(action === 'submit-seer' ? 'submit_seer' : 'submit_knight', { targetId });
    }
    if (action === 'pause-game') return sendCommand('pause_game');
    if (action === 'resume-game') return sendCommand('resume_game');
    if (action === 'force-end') {
      if (confirm('ゲームを強制終了しますか？この操作は取り消せません。')) return sendCommand('force_end');
    }
    if (action === 'copy-code') {
      try { await navigator.clipboard.writeText(currentCode); showToast('ルームコードをコピーしました。'); }
      catch { showToast(`ルームコード：${currentCode}`); }
    }
    if (action === 'copy-summary') {
      const lines = [`WEREWOLF GM / ${currentCode}`, `勝者：${(currentView.game.winners?.factions || []).map(id => factionNames[id] || id).join('・')}`, currentView.game.winners?.reason || '', ...currentView.players.map(player => `${player.name}: ${player.roleName || player.role || '不明'}`)];
      try { await navigator.clipboard.writeText(lines.join('\n')); showToast('ゲーム結果をコピーしました。'); }
      catch { showToast('コピーできませんでした。'); }
    }
    if (action === 'back-home') {
      stopPolling(); currentCode = ''; currentToken = ''; currentRecoveryCode = ''; currentView = null;
      history.replaceState({}, '', location.pathname);
      renderHome();
    }
  });

  $('#settings-toggle').addEventListener('click', () => {
    $('#api-url').value = apiBase;
    $('#api-test-result').textContent = '';
    dialog.showModal();
  });
  $('#save-api-url').addEventListener('click', async event => {
    event.preventDefault();
    if (await testConnection()) {
      dialog.close();
      if (currentCode && currentToken) await refreshView(false);
      else renderHome();
      showToast('接続先を保存しました。');
    }
  });


  $('#recovery-toggle').addEventListener('click', () => {
    $('#recovery-code-value').textContent = currentRecoveryCode || '復帰コードがありません';
    $('#recovery-dialog').showModal();
  });
  $('#close-recovery').addEventListener('click', () => $('#recovery-dialog').close());
  $('#copy-recovery').addEventListener('click', async () => {
    if (!currentRecoveryCode) return showToast('復帰コードがありません。');
    try { await navigator.clipboard.writeText(currentRecoveryCode); showToast('復帰コードをコピーしました。'); }
    catch { showToast(`復帰コード：${currentRecoveryCode}`); }
  });

  async function boot() {
    renderHome();
    const params = new URLSearchParams(location.search);
    const code = (params.get('room') || localStorage.getItem('werewolf-gm-last-room') || '').toUpperCase();
    const token = code ? localStorage.getItem(sessionPrefix + code) : '';
    const recoveryCode = code ? localStorage.getItem('werewolf-gm-recovery:' + code) || '' : '';
    if (code && token && apiBase) {
      try { await enterRoom(code, token, recoveryCode); }
      catch { renderHome(); }
    } else if (!apiBase) {
      $('#api-url').value = '';
    }
  }
  boot();
})();
