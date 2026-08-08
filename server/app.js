'use strict';
const CARDS = require('../cards.json');

const CARD_IDS = CARDS.map((c) => c.id);
const SERVERS = {
  official: { label: '官服', pattern: /^[1-3]\d{8}$/ },
  bili: { label: 'B服', pattern: /^5\d{8}$/ },
  overseas: { label: '国际服', pattern: /^[6-9]\d{8,9}$/ },
};
const DEVICE_RE = /^[A-Za-z0-9_-]{8,128}$/;
const REPORT_REASONS = ['已完成', '信息过期', '信息不实', '争议'];
const NICKNAME_COOLDOWN_MS = 30 * 24 * 3600 * 1000;
const ADMIN_MAX_FAILS = 10;
const ADMIN_WINDOW_MS = 15 * 60 * 1000;

function isCard(id) {
  return Number.isInteger(id) && id >= 1 && id <= 22;
}

function lastId(info) {
  return info.meta.lastInsertRowid ?? info.meta.last_row_id;
}

async function hashDevice(device) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(device));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function periodOf(date) {
  const d = new Date(date.getTime() + 8 * 3600 * 1000); // Asia/Shanghai
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

class HttpError extends Error {
  constructor(status, error) {
    super(error);
    this.status = status;
    this.error = error;
  }
}

  function createApp({ db, adminKey = 'change-me-admin-key', now }) {
  const current = now || new Date();
  const period = periodOf(current);
  const nowIso = current.toISOString();
  const adminFails = new Map();
  let expiredPeriod = null;

  function json(status, body) {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      },
    });
  }

  function options() {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
        'access-control-allow-headers': 'content-type,x-device-id,x-admin-key',
        'access-control-max-age': '86400',
      },
    });
  }

  async function readJson(request) {
    try {
      return await request.json();
    } catch {
      throw new HttpError(400, '请求体不是合法 JSON');
    }
  }

  function deviceOf(request) {
    const d = (request.headers.get('x-device-id') || '').trim();
    if (!DEVICE_RE.test(d)) return null;
    return d;
  }

  function requireDevice(request) {
    const d = deviceOf(request);
    if (!d) throw new HttpError(401, '缺少有效的设备标识（x-device-id）');
    return d;
  }

  async function requirePlayer(request) {
    const d = requireDevice(request);
    const p = await db.prepare('SELECT * FROM players WHERE device_hash = ?').bind(await hashDevice(d)).first();
    if (!p) throw new HttpError(401, '请先登记你的 UID 档案');
    return { player: p, device: d };
  }

  async function expireOldPosts() {
    if (expiredPeriod === period) return; // 同一周期内只需清理一次
    await db.prepare(
      "UPDATE posts SET status='expired', updated_at=? WHERE status IN ('open','matched') AND period < ?"
    ).bind(nowIso, period).run();
    expiredPeriod = period;
  }

  async function flaggedTargets() {
    const rows = (await db.prepare(
      `SELECT target_type, target_id FROM reports
       WHERE status='pending'
       GROUP BY target_type, target_id
       HAVING COUNT(DISTINCT reporter_hash) >= 2`
    ).all()).results;
    const posts = new Set();
    const players = new Set();
    for (const r of rows) {
      if (r.target_type === 'post') posts.add(r.target_id);
      if (r.target_type === 'player') players.add(`${r.target_id}`);
    }
    return { flaggedPosts: posts, flaggedPlayers: players };
  }

  async function getCounts(server, uid) {
    const rows = (await db.prepare(
      'SELECT card_id, count FROM card_counts WHERE server = ? AND uid = ?'
    ).bind(server, uid).all()).results;
    const out = {};
    for (const id of CARD_IDS) out[id] = 0;
    for (const r of rows) out[r.card_id] = Number(r.count);
    return out;
  }

  async function getPlayer(server, uid) {
    return await db.prepare('SELECT * FROM players WHERE server = ? AND uid = ?').bind(server, uid).first();
  }

  function playerPublic(p) {
    return {
      uid: p.uid,
      server: p.server,
      nickname: p.nickname,
      last_update_period: p.last_update_period,
      nickname_updated_at: p.nickname_updated_at,
      completed_trades: Number(p.completed_trades),
      stale: p.last_update_period < period,
    };
  }

  function postPublic(row, owner) {
    return {
      id: row.id,
      server: row.owner_server,
      nickname: owner ? owner.nickname : row.owner_uid,
      offered_card: row.offered_card,
      want_mode: row.want_mode,
      wanted_card: row.wanted_card,
      expected_online: row.expected_online,
      status: row.status,
      period: row.period,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_trades: owner ? Number(owner.completed_trades) : 0,
      stale: owner ? owner.last_update_period < period : false,
    };
  }

  async function postRow(id) {
    return await db.prepare(
      `SELECT p.*, pl.nickname, pl.completed_trades, pl.last_update_period
       FROM posts p JOIN players pl ON pl.server = p.owner_server AND pl.uid = p.owner_uid
       WHERE p.id = ?`
    ).bind(id).first();
  }

  async function applicationsOf(postId) {
    return (await db.prepare(
      `SELECT a.*, pl.nickname FROM applications a
       JOIN players pl ON pl.server = a.applicant_server AND pl.uid = a.applicant_uid
       WHERE a.post_id = ? ORDER BY a.id`
    ).bind(postId).all()).results;
  }

  async function postFull(row, appsOverride) {
    const post = postPublic(row, row);
    post.uid = row.owner_uid;
    post.remind_poster = Number(row.remind_poster) === 1;
    const apps = appsOverride || await applicationsOf(row.id);
    post.applications = apps.map((a) => ({
      id: a.id,
      applicant_uid: a.applicant_uid,
      applicant_server: a.applicant_server,
      nickname: a.nickname,
      provided_card: a.provided_card,
      message: a.message,
      expected_online: a.expected_online,
      status: a.status,
      applicant_confirmed: Number(a.applicant_confirmed) === 1,
      created_at: a.created_at,
    }));
    const locked = apps.find((a) => a.status === 'locked')
      || (Number(row.remind_poster) === 1 ? apps.find((a) => a.status === 'done') : null);
    post.locked_application = locked
      ? {
          id: locked.id,
          applicant_uid: locked.applicant_uid,
          nickname: locked.nickname,
          provided_card: locked.provided_card,
          expected_online: locked.expected_online,
        }
      : null;
    return post;
  }

  async function register(request) {
    const device = requireDevice(request);
    const body = await readJson(request);
    const server = body.server;
    const uid = String(body.uid || '').trim();
    const nickname = String(body.nickname || '').trim().slice(0, 20);
    if (!SERVERS[server]) throw new HttpError(400, '服务器不合法');
    if (!SERVERS[server].pattern.test(uid)) throw new HttpError(400, 'UID 与该服务器不匹配');
    if (!nickname) throw new HttpError(400, '昵称不能为空');
    const hash = await hashDevice(device);
    const existing = await getPlayer(server, uid);
    let takeover = false;
    if (existing && existing.device_hash === hash) {
      // 同设备重复登记是幂等操作：不悄悄改昵称（昵称走 PATCH /api/players/me/nickname，带 30 天冷却）
    } else if (existing) {
      takeover = true;
    const snapshot = {
        nickname: existing.nickname,
        device_hash: existing.device_hash,
        completed_trades: Number(existing.completed_trades),
        last_update_period: existing.last_update_period,
        created_at: existing.created_at,
        collection: await getCounts(server, uid),
      };
      await db.prepare(
        'INSERT INTO audit (server, uid, snapshot, reason, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(server, uid, JSON.stringify(snapshot), 'takeover', nowIso).run();
      await db.prepare(
        `UPDATE players SET nickname = ?, device_hash = ?, last_update_period = ?, nickname_updated_at = NULL, completed_trades = 0
         WHERE server = ? AND uid = ?`
      ).bind(nickname, hash, period, server, uid).run();
      await db.prepare('DELETE FROM card_counts WHERE server = ? AND uid = ?').bind(server, uid).run();
      for (const id of CARD_IDS) {
        await db.prepare(
          'INSERT INTO card_counts (server, uid, card_id, count) VALUES (?, ?, ?, 0)'
        ).bind(server, uid, id).run();
      }
    } else {
      await db.prepare(
        `INSERT INTO players (server, uid, nickname, device_hash, last_update_period, completed_trades, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`
      ).bind(server, uid, nickname, hash, period, nowIso).run();
      for (const id of CARD_IDS) {
        await db.prepare(
          'INSERT INTO card_counts (server, uid, card_id, count) VALUES (?, ?, ?, 0)'
        ).bind(server, uid, id).run();
      }
    }
    const player = await getPlayer(server, uid);
    return json(200, { takeover, player: playerPublic(player), collection: await getCounts(server, uid) });
  }

  async function updateCollection(request) {
    const { player } = await requirePlayer(request);
    const body = await readJson(request);
    if (!body.counts || typeof body.counts !== 'object' || Array.isArray(body.counts)) {
      throw new HttpError(400, 'counts 必须是 {卡号: 数量}');
    }
    const entries = [];
    for (const [key, value] of Object.entries(body.counts)) {
      const id = Number(key);
      if (!isCard(id)) throw new HttpError(400, `卡号不合法: ${key}`);
      if (!Number.isInteger(value) || value < 0 || value > 99) {
        throw new HttpError(400, `卡 ${id} 数量必须为 0~99 的整数`);
      }
      entries.push([id, value]);
    }
    for (const [id, value] of entries) {
      await db.prepare(
        `INSERT INTO card_counts (server, uid, card_id, count) VALUES (?, ?, ?, ?)
         ON CONFLICT(server, uid, card_id) DO UPDATE SET count = excluded.count`
      ).bind(player.server, player.uid, id, value).run();
    }
    await db.prepare('UPDATE players SET last_update_period = ? WHERE server = ? AND uid = ?')
      .bind(period, player.server, player.uid).run();
    return json(200, {
      player: playerPublic(await getPlayer(player.server, player.uid)),
      collection: await getCounts(player.server, player.uid),
    });
  }

  async function updateNickname(request) {
    const { player } = await requirePlayer(request);
    const body = await readJson(request);
    const nickname = String(body.nickname || '').trim();
    if (!nickname || nickname.length > 20) throw new HttpError(400, '昵称必须为 1~20 个字符');
    const last = player.nickname_updated_at;
    if (last) {
      const elapsed = current.getTime() - new Date(last).getTime();
      if (elapsed < NICKNAME_COOLDOWN_MS) {
        const days = Math.ceil((NICKNAME_COOLDOWN_MS - elapsed) / 86400000);
        throw new HttpError(429, `昵称 30 天内仅可修改一次，还需等待 ${days} 天`);
      }
    }
    await db.prepare('UPDATE players SET nickname = ?, nickname_updated_at = ? WHERE server = ? AND uid = ?')
      .bind(nickname, nowIso, player.server, player.uid).run();
    return json(200, { player: playerPublic(await getPlayer(player.server, player.uid)) });
  }

  async function me(request) {
    const { player } = await requirePlayer(request);
    await expireOldPosts();
    const myRows = (await db.prepare(
      `SELECT p.*, pl.nickname, pl.completed_trades, pl.last_update_period
       FROM posts p JOIN players pl ON pl.server = p.owner_server AND pl.uid = p.owner_uid
       WHERE p.owner_server = ? AND p.owner_uid = ? ORDER BY p.updated_at DESC, p.id DESC`
    ).bind(player.server, player.uid).all()).results;
    const appRows = (await db.prepare(
      `SELECT a.*, pl.nickname FROM applications a
       JOIN players pl ON pl.server = a.applicant_server AND pl.uid = a.applicant_uid
       WHERE a.post_id IN (SELECT id FROM posts WHERE owner_server = ? AND owner_uid = ?)
       ORDER BY a.id`
    ).bind(player.server, player.uid).all()).results;
    const appsByPost = new Map();
    for (const a of appRows) {
      if (!appsByPost.has(a.post_id)) appsByPost.set(a.post_id, []);
      appsByPost.get(a.post_id).push(a);
    }
    const myPosts = await Promise.all(myRows.map((r) => postFull(r, appsByPost.get(r.id) || [])));
    const myApps = (await db.prepare(
      `SELECT a.*, p.offered_card AS post_offered_card, p.want_mode, p.wanted_card, p.status AS post_status,
              pl.nickname AS owner_nickname
       FROM applications a
       JOIN posts p ON p.id = a.post_id
       JOIN players pl ON pl.server = p.owner_server AND pl.uid = p.owner_uid
       WHERE a.applicant_server = ? AND a.applicant_uid = ? ORDER BY a.id DESC`
    ).bind(player.server, player.uid).all()).results;
    const reminders = [];
    for (const post of myPosts) {
      if (post.remind_poster && post.status === 'matched' && post.locked_application) {
        reminders.push({
          post_id: post.id,
          application_id: post.locked_application.id,
          counterpart_nickname: post.locked_application.nickname,
          offered_card: post.offered_card,
          provided_card: post.locked_application.provided_card,
        });
      }
    }
    return json(200, {
      player: playerPublic(player),
      collection: await getCounts(player.server, player.uid),
      current_period: period,
      stale: player.last_update_period < period,
      reminders,
      posts: myPosts,
      applications: myApps.map((a) => ({
        id: a.id,
        post_id: a.post_id,
        post_status: a.post_status,
        offered_card: a.post_offered_card,
        want_mode: a.want_mode,
        wanted_card: a.wanted_card,
        provided_card: a.provided_card,
        status: a.status,
        applicant_confirmed: Number(a.applicant_confirmed) === 1,
        owner_uid: a.owner_uid,
        owner_nickname: a.owner_nickname,
        created_at: a.created_at,
      })),
    });
  }

  async function listPosts(request) {
    await expireOldPosts();
    const { flaggedPosts, flaggedPlayers } = await flaggedTargets();
    const mine = new URL(request.url).searchParams.get('mine') === '1';
    if (mine) {
      const { player } = await requirePlayer(request);
      const rows = (await db.prepare(
        `SELECT p.*, pl.nickname, pl.completed_trades, pl.last_update_period
         FROM posts p JOIN players pl ON pl.server = p.owner_server AND pl.uid = p.owner_uid
         WHERE p.owner_server = ? AND p.owner_uid = ? ORDER BY p.updated_at DESC, p.id DESC`
      ).bind(player.server, player.uid).all()).results;
      const appRows = (await db.prepare(
        `SELECT a.*, pl.nickname FROM applications a
         JOIN players pl ON pl.server = a.applicant_server AND pl.uid = a.applicant_uid
         WHERE a.post_id IN (SELECT id FROM posts WHERE owner_server = ? AND owner_uid = ?)
         ORDER BY a.id`
      ).bind(player.server, player.uid).all()).results;
      const appsByPost = new Map();
      for (const a of appRows) {
        if (!appsByPost.has(a.post_id)) appsByPost.set(a.post_id, []);
        appsByPost.get(a.post_id).push(a);
      }
      return json(200, { posts: await Promise.all(rows.map((r) => postFull(r, appsByPost.get(r.id) || []))), current_period: period });
    }
    const rows = (await db.prepare(
      `SELECT p.*, pl.nickname, pl.completed_trades, pl.last_update_period
       FROM posts p JOIN players pl ON pl.server = p.owner_server AND pl.uid = p.owner_uid
       WHERE p.status = 'open' AND p.period = ? ORDER BY p.updated_at DESC, p.id DESC`
    ).bind(period).all()).results;
    const posts = rows
      .filter((r) => !flaggedPosts.has(r.id) && !flaggedPlayers.has(`${r.owner_server}|${r.owner_uid}`))
      .map((r) => postPublic(r, r));
    return json(200, { posts, current_period: period });
  }

  async function createPost(request) {
    const { player } = await requirePlayer(request);
    const body = await readJson(request);
    const offered = Number(body.offered_card);
    if (!isCard(offered)) throw new HttpError(400, '换出牌不合法');
    const mode = body.want_mode;
    if (mode !== 'any' && mode !== 'specific') throw new HttpError(400, '想要模式必须是 any 或 specific');
    const wanted = body.wanted_card == null ? null : Number(body.wanted_card);
    if (mode === 'specific' && !isCard(wanted)) throw new HttpError(400, '指定牌不合法');
    const counts = await getCounts(player.server, player.uid);
    if ((counts[offered] || 0) < 1) throw new HttpError(400, '你没有这张牌可以换出');
    if (mode === 'specific') {
      if (wanted === offered) throw new HttpError(400, '换出牌和想要牌不能相同');
      if ((counts[wanted] || 0) > 0) throw new HttpError(400, '你已经拥有想要换入的牌');
    }
    const expected = body.expected_online ? String(body.expected_online).trim().slice(0, 100) : null;
    const info = await db.prepare(
      `INSERT INTO posts (owner_server, owner_uid, offered_card, want_mode, wanted_card, expected_online, status, period, remind_poster, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, 0, ?, ?)`
    ).bind(player.server, player.uid, offered, mode, wanted, expected, period, nowIso, nowIso).run();
    const row = await postRow(lastId(info));
    return json(200, { post: await postFull(row) });
  }

  async function postDetail(request, id) {
    await expireOldPosts();
    const row = await postRow(id);
    if (!row) throw new HttpError(404, '帖子不存在');
    const { flaggedPosts } = await flaggedTargets();
    const device = deviceOf(request);
    const player = device ? await db.prepare('SELECT * FROM players WHERE device_hash = ?').bind(await hashDevice(device)).first() : null;
    const isOwner = player && player.server === row.owner_server && player.uid === row.owner_uid;
    const apps = await applicationsOf(id);
    const isApplicant = player && apps.some(
      (a) => a.applicant_uid === player.uid && a.applicant_server === player.server && ['locked', 'done'].includes(a.status)
    );
    if (flaggedPosts.has(id) && !isOwner && !isApplicant) throw new HttpError(404, '帖子不存在');
    if (isOwner || isApplicant) return json(200, { post: await postFull(row), is_participant: true });
    return json(200, { post: postPublic(row, row), is_participant: false });
  }

  async function createApplication(request, postId) {
    const { player } = await requirePlayer(request);
    const body = await readJson(request);
    await expireOldPosts();
    const row = await postRow(postId);
    if (!row) throw new HttpError(404, '帖子不存在');
    if (row.status !== 'open') {
      const msg = row.status === 'matched' ? '该帖已被匹配' : '该帖已关闭或过期';
      throw new HttpError(409, msg);
    }
    if (row.owner_server === player.server && row.owner_uid === player.uid) {
      throw new HttpError(400, '不能申请自己的帖子');
    }
    if (row.owner_server !== player.server) throw new HttpError(422, '服务器不同，无法联机交换');
    const provided = Number(body.provided_card);
    if (!isCard(provided)) throw new HttpError(400, '提供牌不合法');
    const offered = row.offered_card;
    const wanted = row.wanted_card;
    const myCounts = await getCounts(player.server, player.uid);
    const ownerCounts = await getCounts(row.owner_server, row.owner_uid);
    if ((myCounts[offered] || 0) > 0) throw new HttpError(422, '你已经持有这张牌，无需交换');
    if ((myCounts[provided] || 0) < 1) throw new HttpError(422, '你没有这张牌可以提供');
    if (row.want_mode === 'any') {
      if ((ownerCounts[provided] || 0) > 0) throw new HttpError(422, '发帖人已拥有你提供的牌');
    } else {
      if (provided !== wanted) throw new HttpError(422, '发帖人指定了想要的牌，你提供的牌不符');
      if ((ownerCounts[wanted] || 0) > 0) throw new HttpError(422, '发帖人已拥有这张牌');
    }
    if ((ownerCounts[offered] || 0) < 1) throw new HttpError(422, '发帖人已无这张牌可换出');
    const claim = await db.prepare(
      "UPDATE posts SET status = 'matched', updated_at = ? WHERE id = ? AND status = 'open'"
    ).bind(nowIso, postId).run();
    if (claim.meta.changes === 0) throw new HttpError(409, '该帖已被匹配');
    let appId;
    try {
      const info = await db.prepare(
        `INSERT INTO applications (post_id, applicant_server, applicant_uid, provided_card, message, expected_online, status, applicant_confirmed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'locked', 0, ?)`
      ).bind(
        postId, player.server, player.uid, provided,
        body.message ? String(body.message).trim().slice(0, 500) : null,
        body.expected_online ? String(body.expected_online).trim().slice(0, 100) : null,
        nowIso
      ).run();
      appId = lastId(info);
    } catch (e) {
      await db.prepare("UPDATE posts SET status = 'open', updated_at = ? WHERE id = ? AND status = 'matched'")
        .bind(nowIso, postId).run();
      throw e;
    }
    const app = await db.prepare('SELECT * FROM applications WHERE id = ?').bind(appId).first();
    const postRowNow = await postRow(postId);
    return json(200, {
      application: {
        id: app.id,
        post_id: app.post_id,
        provided_card: app.provided_card,
        status: app.status,
        created_at: app.created_at,
      },
      post: await postFull(postRowNow),
    });
  }

  async function cancelPost(request, postId) {
    const { player } = await requirePlayer(request);
    await expireOldPosts();
    const row = await postRow(postId);
    if (!row) throw new HttpError(404, '帖子不存在');
    if (row.owner_server !== player.server || row.owner_uid !== player.uid) {
      throw new HttpError(403, '只能取消自己的帖子');
    }
    if (row.status === 'matched') {
      await db.prepare("UPDATE posts SET status = 'open', updated_at = ? WHERE id = ? AND status = 'matched'")
        .bind(nowIso, postId).run();
      await db.prepare("UPDATE applications SET status = 'withdrawn' WHERE post_id = ? AND status = 'locked'")
        .bind(postId).run();
    } else if (row.status === 'open') {
      await db.prepare("UPDATE posts SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'open'")
        .bind(nowIso, postId).run();
    } else {
      throw new HttpError(409, '当前状态不可取消');
    }
    return json(200, { post: await postFull(await postRow(postId)) });
  }

  async function cancelApplication(request, appId) {
    const { player } = await requirePlayer(request);
    const app = await db.prepare('SELECT * FROM applications WHERE id = ?').bind(appId).first();
    if (!app) throw new HttpError(404, '申请不存在');
    if (app.applicant_server !== player.server || app.applicant_uid !== player.uid) {
      throw new HttpError(403, '只能取消自己的申请');
    }
    if (app.status !== 'locked') throw new HttpError(409, '该申请已不是锁定状态');
    await db.prepare("UPDATE applications SET status = 'withdrawn' WHERE id = ? AND status = 'locked'")
      .bind(appId).run();
    await db.prepare("UPDATE posts SET status = 'open', updated_at = ? WHERE id = ? AND status = 'matched'")
      .bind(nowIso, app.post_id).run();
    return json(200, {
      application: { ...app, status: 'withdrawn' },
      post: await postFull(await postRow(app.post_id)),
    });
  }

  async function confirmApplication(request, appId) {
    const { player } = await requirePlayer(request);
    await expireOldPosts();
    const app = await db.prepare('SELECT * FROM applications WHERE id = ?').bind(appId).first();
    if (!app) throw new HttpError(404, '申请不存在');
    const post = await postRow(app.post_id);
    if (!post) throw new HttpError(404, '帖子不存在');
    const isApplicant = player.server === app.applicant_server && player.uid === app.applicant_uid;
    const isOwner = player.server === post.owner_server && player.uid === post.owner_uid;
    if (!isApplicant && !isOwner) throw new HttpError(403, '只有匹配双方可以确认');
    if (app.status === 'withdrawn') throw new HttpError(409, '该交换已取消');

    let gained, lost;
    if (isApplicant) {
      gained = post.offered_card; // 申请人换入 X
      lost = app.provided_card;   // 申请人换出 Z
      if (Number(app.applicant_confirmed) === 1) throw new HttpError(409, '你已经确认过这笔交换');
      if (post.status !== 'matched' && post.status !== 'closed') throw new HttpError(409, '当前状态不可确认');
    } else {
      gained = app.provided_card; // 发帖人换入 Z
      lost = post.offered_card;   // 发帖人换出 X
      if (post.status !== 'matched') throw new HttpError(409, '帖子已关闭或过期，无法确认');
    }
    const counts = await getCounts(player.server, player.uid);
    if ((counts[lost] || 0) < 1) throw new HttpError(422, '你的持有不足，无法确认交换');

    const swap = await db.prepare(
      `UPDATE card_counts
       SET count = count + CASE WHEN card_id = ? THEN 1 ELSE -1 END
       WHERE server = ? AND uid = ? AND card_id IN (?, ?)
         AND (SELECT count FROM card_counts WHERE server = ? AND uid = ? AND card_id = ?) >= 1`
    ).bind(gained, player.server, player.uid, gained, lost, player.server, player.uid, lost).run();
    if (swap.meta.changes < 2) throw new HttpError(422, '持有数据异常，无法确认');

    if (isApplicant) {
      await db.prepare(
        "UPDATE applications SET applicant_confirmed = 1, status = 'done' WHERE id = ? AND applicant_confirmed = 0"
      ).bind(appId).run();
      await db.prepare('UPDATE posts SET remind_poster = 1, updated_at = ? WHERE id = ?')
        .bind(nowIso, app.post_id).run();
    } else {
      await db.prepare(
        "UPDATE posts SET status = 'closed', remind_poster = 0, updated_at = ? WHERE id = ? AND status = 'matched'"
      ).bind(nowIso, app.post_id).run();
      await db.prepare("UPDATE applications SET status = 'done' WHERE id = ? AND status IN ('locked','done')")
        .bind(appId).run();
    }
    await db.prepare('UPDATE players SET completed_trades = completed_trades + 1 WHERE server = ? AND uid = ?')
      .bind(player.server, player.uid).run();

    const freshApp = await db.prepare('SELECT * FROM applications WHERE id = ?').bind(appId).first();
    return json(200, {
      player: playerPublic(await getPlayer(player.server, player.uid)),
      collection: await getCounts(player.server, player.uid),
      application: {
        id: freshApp.id,
        status: freshApp.status,
        applicant_confirmed: Number(freshApp.applicant_confirmed) === 1,
      },
      post: await postFull(await postRow(app.post_id)),
    });
  }

  async function createReport(request) {
    const device = requireDevice(request);
    const body = await readJson(request);
    const { target_type: targetType, target_id: targetId, reason } = body;
    if (!['post', 'player'].includes(targetType)) throw new HttpError(400, 'target_type 不合法');
    const reasonStr = String(reason || '').trim().slice(0, 100);
    if (!REPORT_REASONS.includes(reasonStr)) throw new HttpError(400, '报告原因不合法');
    if (targetType === 'post') {
      if (!Number.isInteger(targetId)) throw new HttpError(400, 'target_id 不合法');
      if (!await postRow(targetId)) throw new HttpError(404, '帖子不存在');
    } else {
      if (typeof targetId !== 'string' || !targetId.includes('|')) throw new HttpError(400, '玩家 target_id 应为 server|uid');
      const [server, uid] = String(targetId).split('|');
      if (!(await getPlayer(server, uid))) throw new HttpError(404, '玩家不存在');
    }
    const info = await db.prepare(
      'INSERT INTO reports (target_type, target_id, reporter_hash, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(targetType, targetId, await hashDevice(device), reasonStr, 'pending', nowIso).run();
    const count = await db.prepare(
      `SELECT COUNT(DISTINCT reporter_hash) AS c FROM reports
       WHERE target_type = ? AND target_id = ? AND status = 'pending'`
    ).bind(targetType, targetId).first();
    const flagged = Number(count.c) >= 2;
    return json(200, {
      report: { id: lastId(info), target_type: targetType, target_id: targetId, reason: reasonStr },
      flagged,
    });
  }

  function requireAdmin(request) {
    const key = (request.headers.get('x-admin-key') || '').trim();
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'local';
    const bucket = `${ip}|${request.headers.get('x-device-id') || ''}`;
    const rec = adminFails.get(bucket);
    if (rec && current.getTime() < rec.resetAt && rec.count >= ADMIN_MAX_FAILS) {
      throw new HttpError(429, '尝试次数过多，请 15 分钟后再试');
    }
    if (!key || key !== adminKey) {
      const nowMs = current.getTime();
      if (!rec || nowMs >= rec.resetAt) {
        adminFails.set(bucket, { count: 1, resetAt: nowMs + ADMIN_WINDOW_MS });
      } else {
        adminFails.set(bucket, { count: rec.count + 1, resetAt: rec.resetAt });
      }
      throw new HttpError(403, '管理员密钥无效');
    }
    adminFails.delete(bucket);
  }

  async function adminListReports(request) {
    requireAdmin(request);
    const reports = (await db.prepare(
      `SELECT r.*, p.status AS post_status, p.owner_uid AS post_owner_uid
       FROM reports r LEFT JOIN posts p ON r.target_type = 'post' AND p.id = r.target_id
       ORDER BY r.created_at DESC`
    ).all()).results;
    return json(200, { reports });
  }

  async function adminResolveReport(request, reportId) {
    requireAdmin(request);
    const body = await readJson(request);
    const action = body.action;
    if (!['dismiss', 'close_post'].includes(action)) throw new HttpError(400, 'action 不合法');
    const report = await db.prepare('SELECT * FROM reports WHERE id = ?').bind(reportId).first();
    if (!report) throw new HttpError(404, '报告不存在');
    if (action === 'close_post') {
      if (report.target_type !== 'post') throw new HttpError(400, '只能关闭帖子类报告');
      await db.prepare("UPDATE posts SET status = 'closed', updated_at = ? WHERE id = ? AND status IN ('open','matched')")
        .bind(nowIso, report.target_id).run();
    }
    await db.prepare("UPDATE reports SET status = 'resolved' WHERE target_type = ? AND target_id = ? AND status = 'pending'")
      .bind(report.target_type, report.target_id).run();
    const fresh = await db.prepare('SELECT * FROM reports WHERE id = ?').bind(reportId).first();
    return json(200, { report: fresh });
  }

  async function adminListPlayers(request) {
    requireAdmin(request);
    const q = new URL(request.url).searchParams.get('q') || '';
    const like = `%${q}%`;
    const rows = (await db.prepare(
      `SELECT p.server, p.uid, p.nickname, p.last_update_period, p.completed_trades, p.created_at,
              (SELECT COUNT(*) FROM posts po WHERE po.owner_server = p.server AND po.owner_uid = p.uid) AS posts
       FROM players p
       WHERE ? = '' OR p.nickname LIKE ? OR p.uid LIKE ?
       ORDER BY p.created_at DESC`
    ).bind(q, like, like).all()).results;
    return json(200, { players: rows.map((r) => ({ ...r, completed_trades: Number(r.completed_trades), posts: Number(r.posts) })) });
  }

  async function adminDeletePlayer(request, server, uid) {
    requireAdmin(request);
    const player = await getPlayer(server, uid);
    if (!player) throw new HttpError(404, '玩家不存在');
    const snapshot = {
      nickname: player.nickname,
      device_hash: player.device_hash,
      completed_trades: Number(player.completed_trades),
      last_update_period: player.last_update_period,
      created_at: player.created_at,
      collection: await getCounts(server, uid),
    };
    await db.prepare('INSERT INTO audit (server, uid, snapshot, reason, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(server, uid, JSON.stringify(snapshot), 'admin_delete', nowIso).run();
    const ownPosts = (await db.prepare('SELECT id FROM posts WHERE owner_server = ? AND owner_uid = ?').bind(server, uid).all()).results;
    let appDeleted = 0;
    for (const p of ownPosts) {
      appDeleted += Number((await db.prepare('DELETE FROM applications WHERE post_id = ?').bind(p.id).run()).meta.changes);
    }
    const postDeleted = Number((await db.prepare('DELETE FROM posts WHERE owner_server = ? AND owner_uid = ?').bind(server, uid).run()).meta.changes);
    appDeleted += Number((await db.prepare('DELETE FROM applications WHERE applicant_server = ? AND applicant_uid = ?').bind(server, uid).run()).meta.changes);
    const cardsDeleted = Number((await db.prepare('DELETE FROM card_counts WHERE server = ? AND uid = ?').bind(server, uid).run()).meta.changes);
    await db.prepare('DELETE FROM players WHERE server = ? AND uid = ?').bind(server, uid).run();
    return json(200, { deleted: { posts: postDeleted, applications: appDeleted, card_counts: cardsDeleted } });
  }

  async function adminListPosts(request) {
    requireAdmin(request);
    const q = new URL(request.url).searchParams.get('q') || '';
    const like = `%${q}%`;
    const rows = (await db.prepare(
      `SELECT p.*, pl.nickname,
              (SELECT COUNT(*) FROM applications a WHERE a.post_id = p.id) AS applications
       FROM posts p JOIN players pl ON pl.server = p.owner_server AND pl.uid = p.owner_uid
       WHERE ? = '' OR CAST(? AS INTEGER) = p.id OR pl.nickname LIKE ? OR pl.uid LIKE ?
       ORDER BY p.id DESC`
    ).bind(q, q, like, like).all()).results;
    return json(200, { posts: rows.map((r) => ({ ...r, applications: Number(r.applications), remind_poster: Number(r.remind_poster) })) });
  }

  async function adminDeletePost(request, postId) {
    requireAdmin(request);
    const row = await postRow(postId);
    if (!row) throw new HttpError(404, '帖子不存在');
    const appDeleted = Number((await db.prepare('DELETE FROM applications WHERE post_id = ?').bind(postId).run()).meta.changes);
    await db.prepare('DELETE FROM posts WHERE id = ?').bind(postId).run();
    return json(200, { deleted: { posts: 1, applications: appDeleted } });
  }

  async function adminListAudit(request) {
    requireAdmin(request);
    const rows = (await db.prepare('SELECT id, server, uid, snapshot, reason, created_at FROM audit ORDER BY id DESC').all()).results;
    return json(200, { audits: rows.map((r) => {
      let snap = {};
      try { snap = JSON.parse(r.snapshot); } catch { /* 忽略损坏快照 */ }
      return { id: r.id, server: r.server, uid: r.uid, reason: r.reason, created_at: r.created_at, snapshot: snap };
    }) });
  }

  async function adminRestoreAudit(request, auditId) {
    requireAdmin(request);
    const audit = await db.prepare('SELECT * FROM audit WHERE id = ?').bind(auditId).first();
    if (!audit) throw new HttpError(404, '审计记录不存在');
    if (await getPlayer(audit.server, audit.uid)) throw new HttpError(409, '该玩家已存在，无法恢复');
    let snap = {};
    try { snap = JSON.parse(audit.snapshot); } catch { /* 空快照按默认恢复 */ }
    let deviceHash = snap.device_hash;
    if (!deviceHash) {
      deviceHash = '';
      for (let i = 0; i < 64; i++) deviceHash += Math.floor(Math.random() * 16).toString(16);
    }
    const nickname = snap.nickname || '已恢复';
    const lastUpdate = snap.last_update_period || period;
    const completed = Number(snap.completed_trades) || 0;
    const createdAt = snap.created_at || nowIso;
    await db.prepare(
      `INSERT INTO players (server, uid, nickname, device_hash, last_update_period, nickname_updated_at, completed_trades, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
    ).bind(audit.server, audit.uid, nickname, deviceHash, lastUpdate, completed, createdAt).run();
    const coll = snap.collection || {};
    for (const id of CARD_IDS) {
      const v = Number(coll[id]) || 0;
      await db.prepare(
        `INSERT INTO card_counts (server, uid, card_id, count) VALUES (?, ?, ?, ?)
         ON CONFLICT(server, uid, card_id) DO UPDATE SET count = excluded.count`
      ).bind(audit.server, audit.uid, id, v).run();
    }
    return json(200, {
      player: playerPublic(await getPlayer(audit.server, audit.uid)),
      collection: await getCounts(audit.server, audit.uid),
    });
  }

  async function stats() {
    await expireOldPosts();
    const playersRow = await db.prepare('SELECT COUNT(*) AS c FROM players').first();
    const playersTotal = Number(playersRow ? playersRow.c : 0);
    const rows = (await db.prepare(
      `SELECT card_id,
              SUM(CASE WHEN count = 0 THEN 1 ELSE 0 END) AS missing,
              COUNT(*) AS total
       FROM card_counts GROUP BY card_id`
    ).all()).results;
    const byId = {};
    for (const r of rows) byId[r.card_id] = r;
    const cards = CARD_IDS.map((id) => {
      const r = byId[id];
      const total = r ? Number(r.total) : 0;
      const missing = r ? Number(r.missing) : 0;
      return { id, missing_rate: total > 0 ? missing / total : 0 };
    });
    return json(200, { current_period: period, total_players: playersTotal, cards });
  }

  async function _handle(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    if (method === 'OPTIONS') return options();
    try {
      if (method === 'GET' && path === '/api/cards') return json(200, CARDS);
      if (method === 'GET' && path === '/api/stats') return await stats();
      if (method === 'GET' && path === '/api/me') return await me(request);
      if (method === 'POST' && path === '/api/players') return await register(request);
      if (method === 'PATCH' && path === '/api/players/me/collection') return await updateCollection(request);
      if (method === 'PATCH' && path === '/api/players/me/nickname') return await updateNickname(request);
      if (method === 'GET' && path === '/api/posts') return await listPosts(request);
      if (method === 'POST' && path === '/api/posts') return await createPost(request);
      let m = path.match(/^\/api\/posts\/(\d+)$/);
      if (method === 'GET' && m) return await postDetail(request, Number(m[1]));
      m = path.match(/^\/api\/posts\/(\d+)\/applications$/);
      if (method === 'POST' && m) return await createApplication(request, Number(m[1]));
      m = path.match(/^\/api\/posts\/(\d+)\/cancel$/);
      if (method === 'POST' && m) return await cancelPost(request, Number(m[1]));
      m = path.match(/^\/api\/applications\/(\d+)\/confirm$/);
      if (method === 'POST' && m) return await confirmApplication(request, Number(m[1]));
      m = path.match(/^\/api\/applications\/(\d+)\/cancel$/);
      if (method === 'POST' && m) return await cancelApplication(request, Number(m[1]));
      if (method === 'POST' && path === '/api/reports') return await createReport(request);
      if (method === 'GET' && path === '/api/admin/reports') return await adminListReports(request);
      m = path.match(/^\/api\/admin\/reports\/(\d+)\/resolve$/);
      if (method === 'POST' && m) return await adminResolveReport(request, Number(m[1]));
      if (method === 'GET' && path === '/api/admin/players') return await adminListPlayers(request);
      m = path.match(/^\/api\/admin\/players\/(official|bili|overseas)\/(\d+)$/);
      if (method === 'DELETE' && m) return await adminDeletePlayer(request, m[1], m[2]);
      if (method === 'GET' && path === '/api/admin/posts') return await adminListPosts(request);
      m = path.match(/^\/api\/admin\/posts\/(\d+)$/);
      if (method === 'DELETE' && m) return await adminDeletePost(request, Number(m[1]));
      if (method === 'GET' && path === '/api/admin/audit') return await adminListAudit(request);
      m = path.match(/^\/api\/admin\/audit\/(\d+)\/restore$/);
      if (method === 'POST' && m) return await adminRestoreAudit(request, Number(m[1]));
      return json(404, { error: '接口不存在' });
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.error });
      return json(500, { error: '服务器内部错误', detail: String((e && e.message) || e) });
    }
  }

  async function handle(request) {
    const t0 = Date.now();
    const res = await _handle(request);
    res.headers.set('x-process-ms', String(Date.now() - t0));
    return res;
  }

  return { handle };
}

module.exports = { createApp, periodOf, hashDevice };
