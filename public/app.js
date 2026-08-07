'use strict';

const API = (window.__API_BASE__ || '').replace(/\/+$/, '');
const SERVERS = { official: '官服', bili: 'B服', overseas: '国际服' };
const REPORT_REASONS = ['已完成', '信息过期', '信息不实', '争议'];
const CARDS_FALLBACK = [
  { id: 1, numeral: 'Ⅰ', name: '魔法师', glyph: '🔮', theme: '#7c6fd0' },
  { id: 2, numeral: 'Ⅱ', name: '女祭司', glyph: '🌙', theme: '#4f6fae' },
  { id: 3, numeral: 'Ⅲ', name: '女皇', glyph: '🌾', theme: '#6a9a5f' },
  { id: 4, numeral: 'Ⅳ', name: '皇帝', glyph: '👑', theme: '#a06a3c' },
  { id: 5, numeral: 'Ⅴ', name: '圣职者', glyph: '⛪', theme: '#8f7a54' },
  { id: 6, numeral: 'Ⅵ', name: '恋人', glyph: '💞', theme: '#c2547a' },
  { id: 7, numeral: 'Ⅶ', name: '战车', glyph: '🛡️', theme: '#7a5f9e' },
  { id: 8, numeral: 'Ⅷ', name: '力量', glyph: '🦁', theme: '#b0813e' },
  { id: 9, numeral: 'Ⅸ', name: '隐者', glyph: '🏮', theme: '#55766e' },
  { id: 10, numeral: 'Ⅹ', name: '命运之轮', glyph: '🎡', theme: '#5d7fa8' },
  { id: 11, numeral: 'Ⅺ', name: '正义', glyph: '⚖️', theme: '#8a8f98' },
  { id: 12, numeral: 'Ⅻ', name: '倒吊人', glyph: '🪢', theme: '#6e86a3' },
  { id: 13, numeral: 'XIII', name: '死神', glyph: '🦴', theme: '#5d6470' },
  { id: 14, numeral: 'XIV', name: '节制', glyph: '🏺', theme: '#4f8f8f' },
  { id: 15, numeral: 'XV', name: '魔鬼', glyph: '🔥', theme: '#a04a3c' },
  { id: 16, numeral: 'XVI', name: '塔', glyph: '🗼', theme: '#8c6a8f' },
  { id: 17, numeral: 'XVII', name: '星', glyph: '✨', theme: '#5f7fbf' },
  { id: 18, numeral: 'XVIII', name: '月亮', glyph: '🌕', theme: '#6b708f' },
  { id: 19, numeral: 'XIX', name: '太阳', glyph: '☀️', theme: '#c08a2c' },
  { id: 20, numeral: 'XX', name: '审判', glyph: '📯', theme: '#8f7a8f' },
  { id: 21, numeral: 'XXI', name: '世界', glyph: '🌍', theme: '#4f8f6e' },
  { id: 22, numeral: 'XXII', name: '愚者', glyph: '🎒', theme: '#a8834f' },
];

const state = {
  cards: null,
  stats: null,
  me: null,
  device: localStorage.getItem('mct_device') || '',
  serverTab: 'all',
  search: '',
  onlyFresh: false,
  countsDraft: null,
};

function ensureDevice() {
  if (!state.device) {
    state.device = 'd' + crypto.randomUUID().replace(/-/g, '');
    localStorage.setItem('mct_device', state.device);
  }
}
ensureDevice();

function card(id) {
  return (state.cards || CARDS_FALLBACK).find((c) => c.id === Number(id)) || { id, name: String(id), glyph: '🃏', theme: '#666' };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function fmtTime(iso) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function api(method, path, body) {
  const headers = {};
  if (state.device) headers['x-device-id'] = state.device;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(API + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const e = new Error((json && json.error) || `请求失败（${res.status}）`);
    e.status = res.status;
    throw e;
  }
  return json;
}

function miniCard(id, count) {
  const c = card(id);
  const cnt = count > 0 ? `<span class="cnt">${count}</span>` : '';
  return `<div class="mini-card" style="background:linear-gradient(160deg,${c.theme},#2b2940)" title="${esc(c.name)}">
    <span class="num">${esc(c.numeral)}</span><span class="glyph">${c.glyph}</span><span class="name">${esc(c.name)}</span>${cnt}
  </div>`;
}

function scarcity(id) {
  if (!state.stats) return null;
  const row = state.stats.cards.find((c) => c.id === Number(id));
  if (!row) return null;
  return Math.round(row.missing_rate * 100);
}

function statusBadge(status) {
  const map = { open: ['进行中', 'pending'], matched: ['已匹配', 'pending'], closed: ['已完成', 'done'], expired: ['已过期', 'muted'], cancelled: ['已取消', 'muted'] };
  const [label, cls] = map[status] || [status, 'muted'];
  return `<span class="badge ${cls}">${label}</span>`;
}

function wantText(post) {
  if (post.want_mode === 'specific') return `换 ${card(post.wanted_card).name}`;
  return '换任意缺牌';
}

async function loadBase() {
  try {
    const [cards, stats] = await Promise.all([api('GET', '/api/cards'), api('GET', '/api/stats')]);
    state.cards = cards;
    state.stats = stats;
  } catch {
    state.cards = CARDS_FALLBACK;
  }
}

async function loadMe(silent) {
  if (!state.device) { state.me = null; return; }
  try {
    state.me = await api('GET', '/api/me');
  } catch {
    state.me = null;
    if (!silent) showToast('请先登记你的 UID 档案');
  }
}

function toast(msg, kind = 'err') {
  const box = document.createElement('div');
  box.className = `banner ${kind}`;
  box.textContent = msg;
  box.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:64px;z-index:99;box-shadow:0 4px 14px rgba(0,0,0,.18)';
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 3200);
}

function view(html) {
  document.getElementById('app').innerHTML = html;
  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === '#' + currentRoute().path);
  });
}

function currentRoute() {
  const hash = location.hash.replace(/^#/, '');
  const m = hash.match(/^\/post\/(\d+)$/);
  if (m) return { name: 'post', path: hash, id: Number(m[1]) };
  const name = hash.replace(/^\//, '') || 'list';
  return { name, path: hash };
}

/* ---------------- 列表 ---------------- */
async function renderList() {
  const data = await api('GET', '/api/posts');
  let posts = data.posts || [];
  if (state.serverTab !== 'all') posts = posts.filter((p) => p.server === state.serverTab);
  if (state.search) {
    const q = state.search.trim().toLowerCase();
    posts = posts.filter((p) =>
      p.nickname.toLowerCase().includes(q) || card(p.offered_card).name.includes(q) ||
      (p.want_mode === 'specific' && card(p.wanted_card).name.includes(q))
    );
  }
  if (state.onlyFresh) posts = posts.filter((p) => !p.stale);

  const banners = [];
  if (state.me && state.me.stale) {
    banners.push(`<div class="banner warn">新一期（${esc(data.current_period)}）已开启，你的持有记录还是上一期的，请到 <a href="#/me">我的档案</a> 更新，否则帖子会被降权。</div>`);
  }
  if (state.me && state.me.reminders && state.me.reminders.length) {
    banners.push(`<div class="banner info">你有 ${state.me.reminders.length} 笔交换被对方确认，请到 <a href="#/me">我的档案</a> 核对并更新记录。</div>`);
  }

  const tabs = ['all', ...Object.keys(SERVERS)].map((s) =>
    `<button class="tab ${state.serverTab === s ? 'active' : ''}" data-tab="${s}">${s === 'all' ? '全部' : SERVERS[s]}</button>`
  ).join('');

  const listHtml = posts.length
    ? posts.map((p) => `
      <a class="post" href="#/post/${p.id}">
        <div class="cards">
          ${miniCard(p.offered_card)}
          <div style="align-self:center;color:var(--muted)">→</div>
          ${p.want_mode === 'specific' ? miniCard(p.wanted_card) : `<div class="mini-card" style="background:linear-gradient(160deg,#5d6470,#2b2940)"><span class="glyph">❔</span><span class="name">任意缺牌</span></div>`}
        </div>
        <div class="meta">
          <span><b>${esc(p.nickname)}</b>${p.stale ? ' <span class="badge stale">待更新</span>' : ''}</span>
          <span>${SERVERS[p.server] || p.server}</span>
          ${p.expected_online ? `<span>在线：${esc(p.expected_online)}</span>` : ''}
          <span>${fmtTime(p.updated_at)}</span>
          <span>已完成 ${p.completed_trades} 笔交换</span>
        </div>
      </a>`).join('')
    : '<div class="empty">还没有符合条件的机会帖，去 <a href="#/new">发一个意向</a> 吧</div>';

  view(`
    ${banners.join('')}
    <div class="card-box">
      <div class="tabs">${tabs}</div>
      <div class="filters">
        <input type="search" id="q" placeholder="搜索昵称 / 牌名" value="${esc(state.search)}">
        <label><input type="checkbox" id="fresh" ${state.onlyFresh ? 'checked' : ''}> 只看本月更新</label>
        <span class="hint" style="margin-left:auto">共 ${posts.length} 条 · 先到先得，申请后自动锁定</span>
      </div>
    </div>
    <div class="post-list">${listHtml}</div>
  `);

  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    state.serverTab = b.dataset.tab;
    renderList();
  }));
  document.getElementById('q').addEventListener('input', (e) => {
    state.search = e.target.value;
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('.post').forEach((post) => {
      post.style.display = post.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  document.getElementById('fresh').addEventListener('change', (e) => {
    state.onlyFresh = e.target.checked;
    renderList();
  });
}

/* ---------------- 发帖 ---------------- */
async function renderNew() {
  if (!state.me) {
    view(`<div class="card-box"><p>发意向前需要先登记 UID 档案。</p><div class="btn-row"><a class="btn primary" href="#/me">去登记</a></div></div>`);
    return;
  }
  const counts = state.me.collection;
  const owned = (state.cards || CARDS_FALLBACK).filter((c) => (counts[c.id] || 0) >= 1);
  const missing = (state.cards || CARDS_FALLBACK).filter((c) => (counts[c.id] || 0) === 0);
  view(`
    <div class="card-box">
      <h2>发交换意向</h2>
      <p class="hint">提交后进入匹配池；满足条件的申请会立即锁定你的帖子，双方互见 UID。帖子只显示昵称，不显示 UID。</p>
      <form id="post-form" class="form-grid" style="margin-top:14px">
        <div class="field">
          <label>换出牌（你持有的牌）</label>
          <select id="f-offered">${owned.map((c) => `<option value="${c.id}">${c.name}（剩 ${counts[c.id]} 张${counts[c.id] === 1 ? '，交换后你将失去唯一一张' : ''}）</option>`).join('') || '<option value="">你还没有任何牌，先去点亮</option>'}</select>
        </div>
        <div class="field">
          <label>想要</label>
          <select id="f-mode">
            <option value="any">任意我没有的牌</option>
            <option value="specific">指定某张牌</option>
          </select>
        </div>
        <div class="field" id="f-wanted-wrap" style="display:none">
          <label>指定想要的牌（你目前没有的）</label>
          <select id="f-wanted">${missing.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label>预计上线 / 回复时间（选填）</label>
          <input id="f-online" maxlength="100" placeholder="如：晚上 8-11 点 / 周末">
        </div>
        <div id="f-err" class="err"></div>
        <button class="btn primary" type="submit">发布意向</button>
      </form>
    </div>
  `);
  const modeEl = document.getElementById('f-mode');
  const wrap = document.getElementById('f-wanted-wrap');
  modeEl.addEventListener('change', () => {
    wrap.style.display = modeEl.value === 'specific' ? '' : 'none';
  });
  document.getElementById('post-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('f-err');
    errBox.textContent = '';
    const offered = Number(document.getElementById('f-offered').value);
    const mode = modeEl.value;
    const wanted = mode === 'specific' ? Number(document.getElementById('f-wanted').value) : null;
    if (!offered) { errBox.textContent = '请选择换出牌'; return; }
    if (mode === 'specific' && !wanted) { errBox.textContent = '请选择指定想要的牌'; return; }
    try {
      const res = await api('POST', '/api/posts', { offered_card: offered, want_mode: mode, wanted_card: wanted, expected_online: document.getElementById('f-online').value || null });
      toast('意向帖已发布', 'ok');
      location.hash = `#/post/${res.post.id}`;
    } catch (err) {
      errBox.textContent = err.message;
    }
  });
}

/* ---------------- 帖子详情 ---------------- */
async function renderPost(id) {
  let data;
  try {
    data = await api('GET', `/api/posts/${id}`);
  } catch (err) {
    view(`<div class="card-box"><p class="err">${esc(err.message)}</p><a class="btn" href="#/">返回列表</a></div>`);
    return;
  }
  const p = data.post;
  const isOwner = state.me && state.me.player && p.uid === state.me.player.uid;
  const app = p.locked_application || (p.applications || []).find((a) => a.status === 'locked');
  const isApplicant = state.me && app && state.me.player && app.applicant_uid === state.me.player.uid;
  const participant = data.is_participant;
  const sOffered = scarcity(p.offered_card);
  const sWanted = p.want_mode === 'specific' ? scarcity(p.wanted_card) : null;

  let body = '';
  if (p.status === 'open') {
    body = renderApplyForm(p);
  } else if (participant) {
    body = renderMatchedView(p, app, isOwner, isApplicant);
  } else {
    body = `<div class="banner info">该帖${p.status === 'matched' ? '已被匹配' : '已结束'}，无法再申请。</div>`;
  }

  view(`
    <a class="btn small" href="#/">← 返回列表</a>
    <div class="card-box" style="margin-top:10px">
      <div class="status-line">${statusBadge(p.status)} ${p.stale ? '<span class="badge stale">待更新</span>' : ''} <span class="hint">${fmtTime(p.updated_at)} 更新</span></div>
      <div class="cards" style="display:flex;gap:10px;align-items:center;margin:10px 0">
        ${miniCard(p.offered_card)}
        <span style="color:var(--muted)">→</span>
        ${p.want_mode === 'specific' ? miniCard(p.wanted_card) : '<div class="mini-card" style="background:linear-gradient(160deg,#5d6470,#2b2940)"><span class="glyph">❔</span><span class="name">任意缺牌</span></div>'}
      </div>
      <dl class="kv">
        <dt>发帖人</dt><dd>${esc(p.nickname)}${p.stale ? '（记录待更新）' : ''}</dd>
        <dt>服务器</dt><dd>${SERVERS[p.server] || p.server}</dd>
        ${p.expected_online ? `<dt>预计上线</dt><dd>${esc(p.expected_online)}</dd>` : ''}
        <dt>完成交换</dt><dd>${p.completed_trades} 笔</dd>
        ${sOffered != null ? `<dt>${esc(card(p.offered_card).name)} 稀缺度</dt><dd>全站 ${sOffered}% 玩家缺失</dd>` : ''}
        ${sWanted != null ? `<dt>${esc(card(p.wanted_card).name)} 稀缺度</dt><dd>全站 ${sWanted}% 玩家缺失</dd>` : ''}
      </dl>
      ${body}
      <div class="report-form">
        <h3 style="font-size:.95rem">报告问题</h3>
        <div class="filters" style="margin-top:8px">
          <select id="r-reason">${REPORT_REASONS.map((r) => `<option>${r}</option>`).join('')}</select>
          <button class="btn small danger" id="r-btn">报告</button>
        </div>
        <div id="r-msg"></div>
      </div>
    </div>
    ${guideBox()}
  `);

  document.getElementById('r-btn').addEventListener('click', async () => {
    try {
      const res = await api('POST', '/api/reports', { target_type: 'post', target_id: p.id, reason: document.getElementById('r-reason').value });
      document.getElementById('r-msg').innerHTML = `<span class="${res.flagged ? 'err' : 'ok'}">${res.flagged ? '已收到双人报告，帖子已降权，等待管理员处理' : '已报告，感谢反馈'}</span>`;
    } catch (err) {
      document.getElementById('r-msg').innerHTML = `<span class="err">${esc(err.message)}</span>`;
    }
  });

  const applyForm = document.getElementById('apply-form');
  if (applyForm) {
    applyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = document.getElementById('a-err');
      errBox.textContent = '';
      try {
        await api('POST', `/api/posts/${p.id}/applications`, {
          provided_card: Number(document.getElementById('a-provided').value),
          message: document.getElementById('a-msg').value || null,
          expected_online: document.getElementById('a-online').value || null,
        });
        toast('申请成功，交易已锁定，双方已互见 UID', 'ok');
        await loadMe(true);
        renderPost(p.id);
      } catch (err) {
        errBox.textContent = err.message;
      }
    });
  }
}

function renderApplyForm(p) {
  if (!state.me) {
    return `<div class="banner info">想申请这笔交换？请先 <a href="#/me">登记 UID 档案</a>。</div>`;
  }
  const counts = state.me.collection;
  let options;
  if (p.want_mode === 'specific') {
    const c = card(p.wanted_card);
    const have = (counts[p.wanted_card] || 0) >= 1;
    options = have
      ? '<option value="">你已经持有这张牌，无法申请</option>'
      : `<option value="${p.wanted_card}">${c.name}</option>`;
  } else {
    options = (state.cards || CARDS_FALLBACK)
      .filter((c) => (counts[c.id] || 0) >= 1)
      .map((c) => `<option value="${c.id}">${c.name}（剩 ${counts[c.id]} 张）</option>`).join('')
      || '<option value="">你还没有可提供的牌</option>';
  }
  return `
    <h3>申请交换</h3>
    <form id="apply-form" class="form-grid" style="margin-top:10px">
      <div class="field">
        <label>我提供（${p.want_mode === 'specific' ? '发帖人指定了想要的牌' : '你持有且发帖人缺的牌'}）</label>
        <select id="a-provided">${options}</select>
      </div>
      <div class="field"><label>我的上线时间（选填）</label><input id="a-online" maxlength="100" placeholder="如：今晚 9 点后"></div>
      <div class="field"><label>留言（选填）</label><textarea id="a-msg" maxlength="500" placeholder="可以约时间或说明你的牌情况"></textarea></div>
      <div id="a-err" class="err"></div>
      <button class="btn primary" type="submit">提出申请（满足条件即锁定）</button>
    </form>
    <p class="hint">申请通过后帖子立即锁定并从列表隐藏，双方互相看到 UID，其余申请自动失效。</p>
  `;
}

function renderMatchedView(p, app, isOwner, isApplicant) {
  if (!app) return '<div class="banner info">暂无匹配信息</div>';
  const myConfirmDone = isOwner
    ? (p.status === 'closed')
    : (app.applicant_confirmed);
  const counterpart = isOwner
    ? { nickname: app.nickname, uid: app.applicant_uid, gave: app.provided_card, gets: p.offered_card }
    : { nickname: p.nickname, uid: p.uid, gave: p.offered_card, gets: app.provided_card };
  const g = card(counterpart.gave);
  const r = card(counterpart.gets);
  return `
    <div class="banner info" style="margin-top:10px">
      <b>已锁定</b>：你和 ${esc(counterpart.nickname)} 互换了。对方 UID：<span class="uid-box">${esc(counterpart.uid)}</span>
      ${isOwner && p.remind_poster ? '<br><span class="hint">对方已确认这笔交换，请核对你的记录。</span>' : ''}
    </div>
    <dl class="kv">
      <dt>你换出</dt><dd>${miniCard(g.id).replace('<div', '<div style="display:inline-block"')}</dd>
      <dt>你换入</dt><dd>${miniCard(r.id).replace('<div', '<div style="display:inline-block"')}</dd>
      <dt>对方昵称</dt><dd>${esc(counterpart.nickname)}</dd>
    </dl>
    <div class="btn-row">
      ${myConfirmDone ? '<span class="badge done">你已确认</span>' : `<button class="btn primary" id="confirm-btn">游戏内已换完，确认并更新我的持有</button>`}
      ${p.status === 'matched' ? `<button class="btn danger" id="cancel-btn">取消这笔交换</button>` : ''}
    </div>
    <div id="act-msg"></div>
  `;
}

function guideBox() {
  return `<div class="card-box">
    <h3 style="font-size:.95rem">游戏内交换四步走</h3>
    <div class="steps">
      <div class="step"><span class="n">1</span><span>用对方的 UID 在游戏内添加好友</span></div>
      <div class="step"><span class="n">2</span><span>在尘歌壶外的多人模式下进入对方世界</span></div>
      <div class="step"><span class="n">3</span><span>使用小道具「月谕之匣」发起并完成 1:1 圣牌互换</span></div>
      <div class="step"><span class="n">4</span><span>回到本站点「确认并更新」，自动调整你的持有记录</span></div>
    </div>
  </div>`;
}

/* ---------------- 我的档案 ---------------- */
async function renderMe() {
  await loadMe(true);
  if (!state.me) {
    view(`
      <div class="card-box">
        <h2>登记我的档案</h2>
        <p class="hint">以 UID 长期保存持有记录，方便后续交换。换设备后用同一 UID 重新登记即「接管」旧档案（旧数据保留可回滚）。</p>
        <form id="reg-form" class="form-grid" style="margin-top:14px">
          <div class="field"><label>昵称</label><input id="r-nick" maxlength="20" placeholder="游戏内昵称" required></div>
          <div class="field"><label>UID</label><input id="r-uid" maxlength="10" inputmode="numeric" placeholder="官服 1~3 开头 9 位" required></div>
          <div class="field"><label>服务器</label><select id="r-server">
            <option value="official">官服（UID 1~3 开头）</option>
            <option value="bili">B服（UID 5 开头）</option>
            <option value="overseas">国际服（UID 6~9 开头）</option>
          </select></div>
          <div id="r-err" class="err"></div>
          <button class="btn primary" type="submit">保存档案</button>
        </form>
      </div>
    `);
    document.getElementById('reg-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = document.getElementById('r-err');
      errBox.textContent = '';
      try {
        const res = await api('POST', '/api/players', {
          nickname: document.getElementById('r-nick').value,
          uid: document.getElementById('r-uid').value,
          server: document.getElementById('r-server').value,
        });
        toast(res.takeover ? '已接管该 UID 的旧档案（原数据已留档）' : '档案已保存', 'ok');
        state.countsDraft = null;
        await loadMe(true);
        renderMe();
      } catch (err) {
        errBox.textContent = err.message;
      }
    });
    return;
  }

  const me = state.me;
  const counts = me.collection;
  if (!state.countsDraft) state.countsDraft = { ...counts };
  const banners = [];
  if (me.stale) banners.push(`<div class="banner warn">你的记录停留在 ${esc(me.player.last_update_period)}，当前期 ${esc(me.current_period)}。更新持有后可恢复正常匹配权重。</div>`);
  if (me.reminders.length) banners.push(`
    <div class="banner info">${me.reminders.map((r) =>
      `对方 ${esc(r.counterpart_nickname)} 确认了与你交换「${esc(card(r.offered_card).name)} → ${esc(card(r.provided_card).name)}」，请核对游戏内结果后更新你的持有。`
    ).join('<br>')}</div>`);

  const myPosts = me.posts.map((p) => {
    const app = p.locked_application;
    const actions = [];
    if (p.status === 'open') actions.push(`<button class="btn small" data-action="cancel-post" data-id="${p.id}">取消</button>`);
    if (p.status === 'matched' && app) {
      actions.push(`<button class="btn small primary" data-action="confirm" data-app="${app.id}">确认并更新</button>`);
      actions.push(`<button class="btn small danger" data-action="cancel-post" data-id="${p.id}">取消</button>`);
    }
    return `<tr>
      <td><a href="#/post/${p.id}">${esc(card(p.offered_card).name)} → ${p.want_mode === 'specific' ? esc(card(p.wanted_card).name) : '任意缺牌'}</a></td>
      <td>${statusBadge(p.status)}</td>
      <td>${app ? `<span class="uid-box">${esc(app.applicant_uid)}</span> ${esc(app.nickname)}` : '—'}</td>
      <td>${actions.join(' ')}</td>
    </tr>`;
  }).join('');

  const myApps = me.applications.map((a) => {
    const actions = [];
    if (a.status === 'locked') {
      actions.push(`<button class="btn small primary" data-action="confirm" data-app="${a.id}">确认并更新</button>`);
      actions.push(`<button class="btn small danger" data-action="cancel-app" data-app="${a.id}">取消申请</button>`);
    }
    return `<tr>
      <td><a href="#/post/${a.post_id}">${esc(card(a.provided_card).name)} → ${a.want_mode === 'specific' ? esc(card(a.wanted_card).name) : '任意缺牌'}</a></td>
      <td>${esc(a.owner_nickname)}</td>
      <td>${statusBadge(a.status)}</td>
      <td>${actions.join(' ')}</td>
    </tr>`;
  }).join('');

  view(`
    ${banners.join('')}
    <div class="card-box">
      <div class="status-line">
        <h2 style="font-size:1.05rem">${esc(me.player.nickname)} 的档案</h2>
        <span class="uid-box">${esc(me.player.uid)}</span>
        <span class="badge muted">${SERVERS[me.player.server]}</span>
        <span class="badge done">已完成 ${me.player.completed_trades} 笔交换</span>
        <span class="hint">最后更新：${esc(me.player.last_update_period)}</span>
      </div>
      <p class="hint">换设备时用同一 UID 重新登记即可接管档案。</p>
    </div>

    <div class="card-box">
      <h3 style="font-size:1rem;margin-bottom:10px">持有记录（22 张）<span class="hint">稀缺度 = 全站缺卡率</span></h3>
      <div class="collection-grid">
        ${(state.cards || CARDS_FALLBACK).map((c) => {
          const s = scarcity(c.id);
          return `<div class="collection-item">
            ${miniCard(c.id, state.countsDraft[c.id])}
            <div class="stepper">
              <button data-dec="${c.id}">−</button>
              <span>${state.countsDraft[c.id]}</span>
              <button data-inc="${c.id}">+</button>
            </div>
            ${s != null ? `<div class="hint">缺 ${s}%</div>` : ''}
          </div>`;
        }).join('')}
      </div>
      <div class="btn-row">
        <button class="btn primary" id="save-counts">保存持有记录</button>
        <span id="save-msg"></span>
      </div>
    </div>

    <div class="card-box">
      <h3 style="font-size:1rem;margin-bottom:8px">我的意向帖</h3>
      <table class="mini">${myPosts ? `<tr><th>内容</th><th>状态</th><th>匹配对象</th><th>操作</th></tr>${myPosts}` : ''}</table>
      ${myPosts ? '' : '<p class="empty">还没有发过意向帖，<a href="#/new">去发一个</a></p>'}
    </div>

    <div class="card-box">
      <h3 style="font-size:1rem;margin-bottom:8px">我提出的申请</h3>
      <table class="mini">${myApps ? `<tr><th>内容</th><th>发帖人</th><th>状态</th><th>操作</th></tr>${myApps}` : ''}</table>
      ${myApps ? '' : '<p class="empty">还没有申请过交换</p>'}
      <div id="act-msg"></div>
    </div>
  `);

  document.querySelectorAll('[data-inc]').forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.dataset.inc);
    if (state.countsDraft[id] < 99) { state.countsDraft[id]++; renderMe(); }
  }));
  document.querySelectorAll('[data-dec]').forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.dataset.dec);
    if (state.countsDraft[id] > 0) { state.countsDraft[id]--; renderMe(); }
  }));
  document.getElementById('save-counts').addEventListener('click', async () => {
    try {
      await api('PATCH', '/api/players/me/collection', { counts: state.countsDraft });
      document.getElementById('save-msg').innerHTML = '<span class="ok">已保存，匹配权重已更新 ✓</span>';
      await loadMe(true);
    } catch (err) {
      document.getElementById('save-msg').innerHTML = `<span class="err">${esc(err.message)}</span>`;
    }
  });
  document.querySelectorAll('[data-action="confirm"]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api('POST', `/api/applications/${b.dataset.app}/confirm`);
      toast('已确认，你的持有记录已自动更新', 'ok');
      await loadMe(true);
      renderMe();
    } catch (err) {
      document.getElementById('act-msg').innerHTML = `<span class="err">${esc(err.message)}</span>`;
    }
  }));
  document.querySelectorAll('[data-action="cancel-post"]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api('POST', `/api/posts/${b.dataset.id}/cancel`);
      toast('帖子已取消', 'ok');
      await loadMe(true);
      renderMe();
    } catch (err) {
      document.getElementById('act-msg').innerHTML = `<span class="err">${esc(err.message)}</span>`;
    }
  }));
  document.querySelectorAll('[data-action="cancel-app"]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api('POST', `/api/applications/${b.dataset.app}/cancel`);
      toast('申请已取消，帖子已重新开放', 'ok');
      await loadMe(true);
      renderMe();
    } catch (err) {
      document.getElementById('act-msg').innerHTML = `<span class="err">${esc(err.message)}</span>`;
    }
  }));
}

/* ---------------- 管理员 ---------------- */
async function renderAdmin() {
  const key = sessionStorage.getItem('mct_admin_key') || '';
  let reportsHtml = '<p class="empty">输入管理员密钥后查看</p>';
  if (key) {
    try {
      const res = await apiWithKey('GET', '/api/admin/reports', key);
      reportsHtml = res.reports.length
        ? `<table class="mini"><tr><th>ID</th><th>目标</th><th>原因</th><th>状态</th><th>操作</th></tr>
          ${res.reports.map((r) => `<tr>
            <td>${r.id}</td>
            <td>${r.target_type === 'post' ? `帖 ${r.target_id}` : `玩家 ${r.target_id}`}${r.post_status ? `（${r.post_status}）` : ''}</td>
            <td>${esc(r.reason)}</td>
            <td>${statusBadge(r.status === 'pending' ? 'matched' : r.status === 'resolved' ? 'closed' : 'open')}</td>
            <td>${r.status === 'pending'
              ? `<button class="btn small" data-resolve="${r.id}" data-action="dismiss">驳回</button>
                 ${r.target_type === 'post' ? `<button class="btn small danger" data-resolve="${r.id}" data-action="close_post">关闭帖子</button>` : ''}`
              : '已处理'}</td>
          </tr>`).join('')}</table>`
        : '<p class="empty">暂无待处理报告</p>';
    } catch (err) {
      reportsHtml = `<p class="err">${esc(err.message)}</p>`;
    }
  }
  view(`
    <div class="card-box">
      <h2 style="font-size:1.05rem">管理员</h2>
      <div class="filters">
        <input type="password" id="admin-key" placeholder="管理员密钥" value="${esc(key)}">
        <button class="btn" id="admin-load">加载</button>
      </div>
      <div id="admin-msg"></div>
      <div style="margin-top:12px">${reportsHtml}</div>
    </div>
  `);
  document.getElementById('admin-load').addEventListener('click', () => {
    sessionStorage.setItem('mct_admin_key', document.getElementById('admin-key').value);
    renderAdmin();
  });
  document.querySelectorAll('[data-resolve]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await apiWithKey('POST', `/api/admin/reports/${b.dataset.resolve}/resolve`, key, { action: b.dataset.action });
      renderAdmin();
    } catch (err) {
      document.getElementById('admin-msg').innerHTML = `<span class="err">${esc(err.message)}</span>`;
    }
  }));
}

async function apiWithKey(method, path, key, body) {
  const headers = { 'x-admin-key': key };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error((json && json.error) || `请求失败（${res.status}）`);
  return json;
}

/* ---------------- 路由 ---------------- */
async function route() {
  const r = currentRoute();
  try {
    if (r.name === 'list') return await renderList();
    if (r.name === 'new') return await renderNew();
    if (r.name === 'post') return await renderPost(r.id);
    if (r.name === 'me') return await renderMe();
    if (r.name === 'admin') return await renderAdmin();
    view('<div class="card-box"><p class="err">页面不存在</p></div>');
  } catch (err) {
    view(`<div class="card-box"><p class="err">${esc(err.message)}</p><a class="btn" href="#/">返回列表</a></div>`);
  }
}

/* ---------------- 帖子详情中的确认/取消按钮（事件绑定在 renderPost 之后） ---------------- */
document.addEventListener('click', async (e) => {
  const confirmBtn = e.target.closest('#confirm-btn');
  if (confirmBtn) {
    const postId = Number(currentRoute().id);
    const data = await api('GET', `/api/posts/${postId}`);
    const p = data.post;
    const app = p.locked_application || (p.applications || []).find((a) => a.status === 'locked');
    try {
      const res = await api('POST', `/api/applications/${app.id}/confirm`);
      toast('已确认，你的持有记录已自动更新', 'ok');
      await loadMe(true);
      renderPost(postId);
    } catch (err) {
      const box = document.getElementById('act-msg');
      if (box) box.innerHTML = `<span class="err">${esc(err.message)}</span>`;
    }
  }
  const cancelBtn = e.target.closest('#cancel-btn');
  if (cancelBtn) {
    const postId = Number(currentRoute().id);
    const data = await api('GET', `/api/posts/${postId}`);
    const p = data.post;
    const me = state.me && state.me.player;
    try {
      if (me && p.uid === me.uid) {
        await api('POST', `/api/posts/${postId}/cancel`);
      } else {
        const app = p.locked_application;
        await api('POST', `/api/applications/${app.id}/cancel`);
      }
      toast('已取消，帖子重新开放', 'ok');
      renderPost(postId);
    } catch (err) {
      const box = document.getElementById('act-msg');
      if (box) box.innerHTML = `<span class="err">${esc(err.message)}</span>`;
    }
  }
});

window.addEventListener('hashchange', route);

(async function init() {
  await loadBase();
  await loadMe(true);
  route();
})();
