const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app.js');
const { createDb } = require('../server/db-shim.js');

const DEV_A = 'device-a';
const DEV_B = 'device-b';
const DEV_C = 'device-c';
const OFFICIAL_A = '111111111';
const OFFICIAL_B = '222222222';
const OFFICIAL_C = '333333333';
const BILI_B = '555555555';

const NOW = new Date('2026-08-07T12:00:00+08:00');

async function setup(now) {
  const db = createDb(':memory:');
  const app = createApp({ db, adminKey: 'test-admin-key', now: now || NOW });
  return { db, app };
}

async function call(app, method, path, { device, adminKey, body } = {}) {
  const headers = {};
  if (device) headers['x-device-id'] = device;
  if (adminKey) headers['x-admin-key'] = adminKey;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await app.handle(new Request('http://test.local' + path, { method, headers, body: payload }));
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function register(app, device, uid, server = 'official', nickname = '玩家') {
  return call(app, 'POST', '/api/players', { device, body: { nickname, uid, server } });
}

async function setCollection(app, device, counts) {
  return call(app, 'PATCH', '/api/players/me/collection', { device, body: { counts } });
}

async function createPost(app, device, body) {
  return call(app, 'POST', '/api/posts', { device, body });
}

function countOf(json, cardId) {
  return json.collection ? json.collection[cardId] : undefined;
}

test('登记与档案', async (t) => {
  await t.test('注册成功返回档案与 22 张零持有，非接管', async () => {
    const { app } = await setup();
    const r = await register(app, DEV_A, OFFICIAL_A, 'official', '阿伟');
    assert.equal(r.status, 200);
    assert.equal(r.json.takeover, false);
    assert.equal(r.json.player.uid, OFFICIAL_A);
    assert.equal(r.json.player.nickname, '阿伟');
    assert.equal(r.json.player.server, 'official');
    assert.equal(Object.keys(r.json.collection).length, 22);
    assert.equal(countOf(r.json, 1), 0);
    assert.equal(r.json.player.last_update_period, '2026-08');
  });

  await t.test('UID 与服务器不匹配被拒绝', async () => {
    const { app } = await setup();
    assert.equal((await register(app, DEV_A, BILI_B, 'official')).status, 400);
    assert.equal((await register(app, DEV_A, '12345', 'official')).status, 400);
    assert.equal((await register(app, DEV_A, OFFICIAL_A, 'bili')).status, 400);
    assert.equal((await register(app, DEV_A, '888888888', 'overseas')).status, 200);
    assert.equal((await register(app, DEV_A, '8888888888', 'overseas')).status, 200);
  });

  await t.test('同设备重复注册不是接管', async () => {
    const { app } = await setup();
    await register(app, DEV_A, OFFICIAL_A);
    const r = await register(app, DEV_A, OFFICIAL_A);
    assert.equal(r.status, 200);
    assert.equal(r.json.takeover, false);
  });

  await t.test('新设备登记同 UID 触发接管，旧设备失去写权限，快照可回滚', async () => {
    const { app, db } = await setup();
    await register(app, DEV_A, OFFICIAL_A, 'official', '旧名');
    await setCollection(app, DEV_A, { 1: 2, 2: 1 });
    const r = await register(app, DEV_B, OFFICIAL_A, 'official', '新名');
    assert.equal(r.status, 200);
    assert.equal(r.json.takeover, true);
    assert.equal(r.json.player.nickname, '新名');
    assert.equal(countOf(r.json, 1), 0);
    const snap = db.raw.prepare('SELECT snapshot FROM audit WHERE server=? AND uid=? ORDER BY id DESC LIMIT 1')
      .get('official', OFFICIAL_A);
    assert.ok(snap, '接管必须留下审计快照');
    const snapCollection = JSON.parse(snap.snapshot).collection;
    assert.equal(snapCollection[1], 2);
    assert.equal(snapCollection[2], 1);
    assert.equal((await setCollection(app, DEV_A, { 3: 1 })).status, 401);
    assert.equal((await setCollection(app, DEV_B, { 3: 1 })).status, 200);
  });

  await t.test('持有更新需要鉴权并校验卡号与数量', async () => {
    const { app } = await setup();
    await register(app, DEV_A, OFFICIAL_A);
    assert.equal((await setCollection(app, 'unknown-device', { 1: 1 })).status, 401);
    assert.equal((await setCollection(app, DEV_A, { 0: 1 })).status, 400);
    assert.equal((await setCollection(app, DEV_A, { 23: 1 })).status, 400);
    assert.equal((await setCollection(app, DEV_A, { 1: -1 })).status, 400);
    const ok = await setCollection(app, DEV_A, { 1: 2, 3: 4 });
    assert.equal(ok.status, 200);
    assert.equal(countOf(ok.json, 1), 2);
    assert.equal(countOf(ok.json, 3), 4);
  });

  await t.test('设备密钥以哈希存储，不落明文', async () => {
    const { app, db } = await setup();
    await register(app, DEV_A, OFFICIAL_A);
    const row = db.raw.prepare('SELECT device_hash FROM players WHERE server=? AND uid=?')
      .get('official', OFFICIAL_A);
    assert.notEqual(row.device_hash, DEV_A);
    assert.match(row.device_hash, /^[0-9a-f]{64}$/);
  });
});

test('意向帖', async (t) => {
  async function seed() {
    const { app } = await setup();
    await register(app, DEV_A, OFFICIAL_A, 'official', '发帖人');
    await setCollection(app, DEV_A, { 1: 2, 2: 0, 5: 1 });
    return app;
  }

  await t.test('未登记不能发帖；不能挂出未持有的牌', async () => {
    const { app } = await setup();
    assert.equal((await createPost(app, 'ghost', { offered_card: 1, want_mode: 'any' })).status, 401);
    await register(app, DEV_A, OFFICIAL_A);
    assert.equal((await createPost(app, DEV_A, { offered_card: 1, want_mode: 'any' })).status, 400);
  });

  await t.test('指定模式不能想要自己已持有的牌，也不能换出=想要', async () => {
    const app = await seed();
    assert.equal((await createPost(app, DEV_A, { offered_card: 1, want_mode: 'specific', wanted_card: 1 })).status, 400);
    assert.equal((await createPost(app, DEV_A, { offered_card: 1, want_mode: 'specific', wanted_card: 5 })).status, 400);
    assert.equal((await createPost(app, DEV_A, { offered_card: 1, want_mode: 'specific', wanted_card: 2 })).status, 200);
  });

  await t.test('公开列表隐藏 UID，只含 open 帖子，按更新时间倒序', async () => {
    const app = await seed();
    await createPost(app, DEV_A, { offered_card: 1, want_mode: 'any', expected_online: '晚8点' });
    const second = await createPost(app, DEV_A, { offered_card: 5, want_mode: 'specific', wanted_card: 2 });
    const list = await call(app, 'GET', '/api/posts');
    assert.equal(list.status, 200);
    assert.equal(list.json.posts.length, 2);
    assert.equal(list.json.posts[0].id, second.json.post.id, '默认时间倒序，新帖在前');
    assert.equal(list.json.posts[0].uid, undefined, '公开列表不得出现 UID');
    assert.equal(list.json.posts[0].nickname, '发帖人');
    assert.equal(list.json.posts[0].offered_card, 5);
    assert.equal(list.json.posts[0].want_mode, 'specific');
    assert.equal(list.json.posts[0].wanted_card, 2);
    assert.equal(list.json.posts[1].expected_online, '晚8点');
  });

  await t.test('mine=1 返回自己的帖子含 UID', async () => {
    const app = await seed();
    await createPost(app, DEV_A, { offered_card: 1, want_mode: 'any' });
    const mine = await call(app, 'GET', '/api/posts?mine=1', { device: DEV_A });
    assert.equal(mine.json.posts[0].uid, OFFICIAL_A);
  });
});

test('申请与原子锁定', async (t) => {
  async function seed({ bili = false } = {}) {
    const { app } = await setup();
    await register(app, DEV_A, OFFICIAL_A, 'official', '发帖人');
    await setCollection(app, DEV_A, { 1: 2 });
    const post = await createPost(app, DEV_A, { offered_card: 1, want_mode: 'any' });
    await register(app, DEV_B, bili ? BILI_B : OFFICIAL_B, bili ? 'bili' : 'official', '申请人');
    await setCollection(app, DEV_B, { 2: 1, 1: 0 });
    return { app, post: post.json.post };
  }

  await t.test('满足条件即锁定：双方互见 UID，其余申请失效', async () => {
    const { app, post } = await seed();
    const apply = await call(app, 'POST', `/api/posts/${post.id}/applications`, {
      device: DEV_B, body: { provided_card: 2 },
    });
    assert.equal(apply.status, 200);
    assert.equal(apply.json.post.status, 'matched');
    assert.equal(apply.json.application.status, 'locked');
    assert.equal(apply.json.post.uid, OFFICIAL_A, '锁定后申请人可见发帖人 UID');

    const posterView = await call(app, 'GET', `/api/posts?mine=1`, { device: DEV_A });
    const myPost = posterView.json.posts.find((p) => p.id === post.id);
    assert.equal(myPost.status, 'matched');
    assert.equal(myPost.locked_application.applicant_uid, OFFICIAL_B, '发帖人可见申请人 UID');

    await register(app, DEV_C, OFFICIAL_C, 'official', '第三人');
    await setCollection(app, DEV_C, { 2: 1 });
    const late = await call(app, 'POST', `/api/posts/${post.id}/applications`, {
      device: DEV_C, body: { provided_card: 2 },
    });
    assert.equal(late.status, 409);
    assert.match(late.json.error, /匹配/);
  });

  await t.test('非参与者看不到匹配双方的 UID', async () => {
    const { app, post } = await seed();
    await call(app, 'POST', `/api/posts/${post.id}/applications`, { device: DEV_B, body: { provided_card: 2 } });
    await register(app, DEV_C, OFFICIAL_C, 'official');
    const outsider = await call(app, 'GET', `/api/posts/${post.id}`, { device: DEV_C });
    assert.equal(outsider.json.post.uid, undefined);
    assert.equal(outsider.json.post.matched_uid, undefined);
    const participant = await call(app, 'GET', `/api/posts/${post.id}`, { device: DEV_B });
    assert.equal(participant.json.post.uid, OFFICIAL_A);
  });

  await t.test('服务器不符被拒绝', async () => {
    const { app, post } = await seed({ bili: true });
    const r = await call(app, 'POST', `/api/posts/${post.id}/applications`, {
      device: DEV_B, body: { provided_card: 2 },
    });
    assert.equal(r.status, 422);
    assert.match(r.json.error, /服务器/);
  });

  await t.test('申请人已持有换出牌被拒绝', async () => {
    const { app, post } = await seed();
    await setCollection(app, DEV_B, { 1: 1 });
    const r = await call(app, 'POST', `/api/posts/${post.id}/applications`, { device: DEV_B, body: { provided_card: 2 } });
    assert.equal(r.status, 422);
  });

  await t.test('申请人没有提供牌被拒绝；任意模式下提供发帖人已持有的牌被拒绝', async () => {
    const { app, post } = await seed();
    const noCard = await call(app, 'POST', `/api/posts/${post.id}/applications`, { device: DEV_B, body: { provided_card: 5 } });
    assert.equal(noCard.status, 422);
    const alreadyOwned = await call(app, 'POST', `/api/posts/${post.id}/applications`, { device: DEV_B, body: { provided_card: 1 } });
    assert.equal(alreadyOwned.status, 422);
  });

  await t.test('指定模式下提供牌必须等于指定牌', async () => {
    const { app } = await setup();
    await register(app, DEV_A, OFFICIAL_A);
    await setCollection(app, DEV_A, { 1: 1, 2: 0, 3: 0 });
    const post = await createPost(app, DEV_A, { offered_card: 1, want_mode: 'specific', wanted_card: 2 });
    await register(app, DEV_B, OFFICIAL_B);
    await setCollection(app, DEV_B, { 3: 1 });
    const wrong = await call(app, 'POST', `/api/posts/${post.json.post.id}/applications`, { device: DEV_B, body: { provided_card: 3 } });
    assert.equal(wrong.status, 422);
    await setCollection(app, DEV_B, { 2: 1, 3: 0 });
    const right = await call(app, 'POST', `/api/posts/${post.json.post.id}/applications`, { device: DEV_B, body: { provided_card: 2 } });
    assert.equal(right.status, 200);
  });

  await t.test('发帖人已无换出牌时申请被拒绝；自己申请自己被拒绝', async () => {
    const { app, post } = await seed();
    await setCollection(app, DEV_A, { 1: 0 });
    const noCard = await call(app, 'POST', `/api/posts/${post.id}/applications`, { device: DEV_B, body: { provided_card: 2 } });
    assert.equal(noCard.status, 422);
    const self = await call(app, 'POST', `/api/posts/${post.id}/applications`, { device: DEV_A, body: { provided_card: 2 } });
    assert.equal(self.status, 400);
  });

  await t.test('任一方取消后帖子回 open 可再次锁定', async () => {
    const { app, post } = await seed();
    await call(app, 'POST', `/api/posts/${post.id}/applications`, { device: DEV_B, body: { provided_card: 2 } });
    const cancel = await call(app, 'POST', `/api/applications/${'1'}/cancel`, { device: DEV_B });
    // 用申请人取消：帖子应回 open
    const list = await call(app, 'GET', '/api/posts');
    assert.equal(list.json.posts.find((p) => p.id === post.id).status, 'open');
    assert.equal(cancel.json.application.status, 'withdrawn');
  });

  await t.test('发帖人主动取消帖子：open 则关闭，matched 则回 open', async () => {
    const { app, post } = await seed();
    await call(app, 'POST', `/api/posts/${post.id}/applications`, { device: DEV_B, body: { provided_card: 2 } });
    const c1 = await call(app, 'POST', `/api/posts/${post.id}/cancel`, { device: DEV_A });
    assert.equal(c1.json.post.status, 'open', 'matched 状态取消后回 open');
    const c2 = await call(app, 'POST', `/api/posts/${post.id}/cancel`, { device: DEV_A });
    assert.equal(c2.json.post.status, 'cancelled', 'open 状态取消后关闭');
  });
});

test('确认并更新', async (t) => {
  async function seed() {
    const { app } = await setup();
    await register(app, DEV_A, OFFICIAL_A, 'official', '发帖人');
    await setCollection(app, DEV_A, { 1: 2, 2: 0 });
    const post = await createPost(app, DEV_A, { offered_card: 1, want_mode: 'any' });
    await register(app, DEV_B, OFFICIAL_B, 'official', '申请人');
    await setCollection(app, DEV_B, { 2: 1, 1: 0 });
    await call(app, 'POST', `/api/posts/${post.json.post.id}/applications`, { device: DEV_B, body: { provided_card: 2 } });
    return { app, post: post.json.post };
  }

  await t.test('申请人确认：自己的牌对调，帖子保持 matched，发帖人收到提醒', async () => {
    const { app, post } = await seed();
    const r = await call(app, 'POST', '/api/applications/1/confirm', { device: DEV_B });
    assert.equal(r.status, 200);
    assert.equal(countOf(r.json, 2), 0, '申请人换出 Z-1');
    assert.equal(countOf(r.json, 1), 1, '申请人换入 X+1');
    assert.equal(r.json.application.status, 'done');
    assert.equal(r.json.post.status, 'matched', '申请人确认不关闭帖子');
    const mine = await call(app, 'GET', '/api/posts?mine=1', { device: DEV_A });
    assert.equal(mine.json.posts[0].remind_poster, true, '发帖人应收到核对提醒');
    const meA = await call(app, 'GET', '/api/me', { device: DEV_A });
    assert.equal(meA.json.reminders.length, 1, '发帖人 /api/me 应出现待核对提醒');
    assert.equal(meA.json.reminders[0].counterpart_nickname, '申请人');
    assert.equal(meA.json.reminders[0].offered_card, 1);
    assert.equal(meA.json.reminders[0].provided_card, 2);
    const again = await call(app, 'POST', '/api/applications/1/confirm', { device: DEV_B });
    assert.equal(again.status, 409, '重复确认被拒绝');
  });

  await t.test('发帖人确认：自己的牌对调并关闭帖子', async () => {
    const { app, post } = await seed();
    const r = await call(app, 'POST', '/api/applications/1/confirm', { device: DEV_A });
    assert.equal(r.status, 200);
    assert.equal(countOf(r.json, 1), 1, '发帖人换出 X-1');
    assert.equal(countOf(r.json, 2), 1, '发帖人换入 Z+1');
    assert.equal(r.json.post.status, 'closed');
  });

  await t.test('双方先后确认各自更新互不冲突', async () => {
    const { app, post } = await seed();
    await call(app, 'POST', '/api/applications/1/confirm', { device: DEV_B });
    const poster = await call(app, 'POST', '/api/applications/1/confirm', { device: DEV_A });
    assert.equal(poster.status, 200);
    assert.equal(countOf(poster.json, 1), 1);
    assert.equal(countOf(poster.json, 2), 1);
    assert.equal(poster.json.post.status, 'closed');
  });

  await t.test('持有不足时确认被拒绝；完成后完成次数累计', async () => {
    const { app, post } = await seed();
    await setCollection(app, DEV_A, { 1: 0 });
    const r = await call(app, 'POST', '/api/applications/1/confirm', { device: DEV_A });
    assert.equal(r.status, 422);
    await setCollection(app, DEV_A, { 1: 1 });
    const ok = await call(app, 'POST', '/api/applications/1/confirm', { device: DEV_A });
    assert.equal(ok.status, 200);
    const me = await call(app, 'GET', '/api/me', { device: DEV_A });
    assert.equal(me.json.player.completed_trades, 1);
  });
});

test('报告与管理员', async (t) => {
  async function seedPost() {
    const { app } = await setup();
    await register(app, DEV_A, OFFICIAL_A, 'official', '发帖人');
    await setCollection(app, DEV_A, { 1: 1 });
    const post = await createPost(app, DEV_A, { offered_card: 1, want_mode: 'any' });
    return { app, post: post.json.post };
  }

  await t.test('单个报告不隐藏，两个不同用户报告后帖子从公开列表隐藏', async () => {
    const { app, post } = await seedPost();
    await register(app, DEV_B, OFFICIAL_B, 'official', '路人乙');
    await register(app, DEV_C, OFFICIAL_C, 'official', '路人丙');
    const r1 = await call(app, 'POST', '/api/reports', { device: DEV_B, body: { target_type: 'post', target_id: post.id, reason: '已完成' } });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.flagged, false);
    assert.equal((await call(app, 'GET', '/api/posts')).json.posts.length, 1);
    const r2 = await call(app, 'POST', '/api/reports', { device: DEV_C, body: { target_type: 'post', target_id: post.id, reason: '已完成' } });
    assert.equal(r2.json.flagged, true);
    assert.equal((await call(app, 'GET', '/api/posts')).json.posts.length, 0, '双人报告后隐藏');
  });

  await t.test('双人报告玩家后，其帖子从公开列表隐藏', async () => {
    const { app, post } = await seedPost();
    await register(app, DEV_B, OFFICIAL_B, 'official', '路人乙');
    await register(app, DEV_C, OFFICIAL_C, 'official', '路人丙');
    const r1 = await call(app, 'POST', '/api/reports', { device: DEV_B, body: { target_type: 'player', target_id: `official|${OFFICIAL_A}`, reason: '信息不实' } });
    assert.equal(r1.json.flagged, false);
    const r2 = await call(app, 'POST', '/api/reports', { device: DEV_C, body: { target_type: 'player', target_id: `official|${OFFICIAL_A}`, reason: '信息不实' } });
    assert.equal(r2.json.flagged, true);
    assert.equal((await call(app, 'GET', '/api/posts')).json.posts.length, 0, '被双人报告的玩家帖子隐藏');
  });

  await t.test('管理员驳回恢复可见，关闭则帖子关闭；管理员接口需要密钥', async () => {
    const { app, post } = await seedPost();
    await register(app, DEV_B, OFFICIAL_B);
    await register(app, DEV_C, OFFICIAL_C);
    await call(app, 'POST', '/api/reports', { device: DEV_B, body: { target_type: 'post', target_id: post.id, reason: '信息不实' } });
    await call(app, 'POST', '/api/reports', { device: DEV_C, body: { target_type: 'post', target_id: post.id, reason: '信息不实' } });
    assert.equal((await call(app, 'GET', '/api/admin/reports')).status, 403);
    const list = await call(app, 'GET', '/api/admin/reports', { adminKey: 'test-admin-key' });
    assert.equal(list.status, 200);
    const reportId = list.json.reports[0].id;
    const dismiss = await call(app, 'POST', `/api/admin/reports/${reportId}/resolve`, {
      adminKey: 'test-admin-key', body: { action: 'dismiss' },
    });
    assert.equal(dismiss.status, 200);
    assert.equal((await call(app, 'GET', '/api/posts')).json.posts.length, 1, '驳回后恢复可见');

    await call(app, 'POST', '/api/reports', { device: DEV_B, body: { target_type: 'post', target_id: post.id, reason: '已完成' } });
    await call(app, 'POST', '/api/reports', { device: DEV_C, body: { target_type: 'post', target_id: post.id, reason: '已完成' } });
    const list2 = await call(app, 'GET', '/api/admin/reports', { adminKey: 'test-admin-key' });
    const pending = list2.json.reports.find((r) => r.status === 'pending');
    const close = await call(app, 'POST', `/api/admin/reports/${pending.id}/resolve`, {
      adminKey: 'test-admin-key', body: { action: 'close_post' },
    });
    assert.equal(close.status, 200);
    const mine = await call(app, 'GET', '/api/posts?mine=1', { device: DEV_A });
    assert.equal(mine.json.posts.find((p) => p.id === post.id).status, 'closed');
  });
});

test('周期与过期', async (t) => {
  await t.test('旧期开放帖自动过期，不再进入公开列表', async () => {
    const { db } = await setup(new Date('2026-07-15T12:00:00+08:00'));
    const old = createApp({ db, adminKey: 'k', now: new Date('2026-07-15T12:00:00+08:00') });
    await register(old, DEV_A, OFFICIAL_A, 'official', '发帖人');
    await setCollection(old, DEV_A, { 1: 1 });
    const post = await createPost(old, DEV_A, { offered_card: 1, want_mode: 'any' });
    assert.equal(post.json.post.period, '2026-07');

    const fresh = createApp({ db, adminKey: 'k', now: new Date('2026-08-01T04:00:00+08:00') });
    const list = await call(fresh, 'GET', '/api/posts');
    assert.equal(list.json.posts.length, 0);
    const mine = await call(fresh, 'GET', '/api/posts?mine=1', { device: DEV_A });
    assert.equal(mine.json.posts[0].status, 'expired');
  });

  await t.test('超过一个周期未更新的档案标记 stale，其帖子带 stale 标记', async () => {
    const { db } = await setup(new Date('2026-07-15T12:00:00+08:00'));
    const old = createApp({ db, adminKey: 'k', now: new Date('2026-07-15T12:00:00+08:00') });
    await register(old, DEV_A, OFFICIAL_A, 'official', '发帖人');
    await setCollection(old, DEV_A, { 1: 1 });
    await createPost(old, DEV_A, { offered_card: 1, want_mode: 'any' });

    const fresh = createApp({ db, adminKey: 'k', now: new Date('2026-08-01T04:00:00+08:00') });
    const me = await call(fresh, 'GET', '/api/me', { device: DEV_A });
    assert.equal(me.json.stale, true);
    const oldApp = createApp({ db, adminKey: 'k', now: new Date('2026-07-20T12:00:00+08:00') });
    const refreshed = await call(oldApp, 'GET', '/api/me', { device: DEV_A });
    assert.equal(refreshed.json.stale, false);
  });
});
