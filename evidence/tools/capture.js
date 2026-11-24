// Drives the real UI on a real local server and saves screenshots to <root>/evidence.
// Each scenario gets its own server + fresh SQLite file so IDs are 1,2,3 in apply order.
const { chromium } = require('playwright-core');
const { spawn, execSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs'), path = require('node:path');
// Uses an installed Chrome (no browser download). Override with CHROME_PATH.
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const ROOT = path.resolve(__dirname, '../..');
const STARTER = ROOT + '/starter';
const EVID = ROOT + '/evidence';
const DBDIR = path.join(require('node:os').tmpdir(), 'assignment2-evidence-dbs');
const PORT = 3100, BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'e'.repeat(64);
const only = process.argv.slice(2);
fs.mkdirSync(EVID, { recursive: true }); fs.mkdirSync(DBDIR, { recursive: true });

let server = null, dbPath = null, browser, ctx, pages = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function startServer() {
  server = spawn(process.execPath, ['src/server.js'], { cwd: STARTER, env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, JWT_SECRET: SECRET }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) return; } catch {} await sleep(100); }
  throw new Error('server did not start');
}
async function stopServer() { if (!server) return; const s = server; server = null; const done = new Promise(r => s.once('exit', r)); s.kill(); await done; }
async function fresh(name) {
  await stopServer(); for (const p of Object.values(pages)) await p.close(); pages = {};
  dbPath = path.join(DBDIR, name + '.sqlite'); for (const s of ['', '-journal', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });
  await startServer();
}
async function restart() { for (const p of Object.values(pages)) await p.close(); pages = {}; await stopServer(); await startServer(); }
function sql(q, ...args) { const db = new DatabaseSync(dbPath); try { db.exec('PRAGMA busy_timeout=5000'); return args.length || /^\s*select/i.test(q) ? db.prepare(q)[/^\s*select/i.test(q) ? 'all' : 'run'](...args) : db.exec(q); } finally { db.close(); } }
const trigger = (name, action) => sql(`CREATE TRIGGER ${name} BEFORE INSERT ON application_history WHEN NEW.action='${action}' BEGIN SELECT RAISE(ABORT,'TEST_INJECTED_FAILURE'); END`);

async function as(user) {
  if (pages[user]) { await pages[user].bringToFront(); return pages[user]; }
  const p = await ctx.newPage(); pages[user] = p;
  await p.goto(BASE + '/');
  await p.click(`[data-user="${user}"]`);
  await p.click('#login-form button[type=submit]');
  await p.waitForFunction(() => !document.querySelector('#login-section').hidden);
  await p.waitForTimeout(250);
  return p;
}
async function event(p, id) { await p.click(`#events article:nth-of-type(${id}) button`); await p.waitForTimeout(300); }
async function refresh(p) { await p.evaluate(() => refresh()); await p.waitForTimeout(200); }
// Raw API call through the page's own api() so the response panel shows the real HTTP result.
async function call(p, method, url, body, opts = {}) {
  const r = await p.evaluate(async ([method, url, body, tok]) => {
    if (tok !== undefined) token = tok;
    try { await api(url, { method, body }); notice(`${method} ${url} 요청 성공`); return 'ok'; } catch (e) { notice(e.message, true); return e.message; }
  }, [method, url, body, opts.token]);
  if (!opts.noRefresh) await refresh(p).catch(() => {});
  return r;
}
const row = (p, id) => p.locator('#applications .app-row').filter({ has: p.locator('strong', { hasText: new RegExp(`#${id}$`) }) });
async function click(p, id, text, urlPart) {
  await Promise.all([p.waitForResponse(r => r.url().includes(urlPart) && r.request().method() === 'POST'), row(p, id).getByRole('button', { name: text }).click()]);
  await p.waitForTimeout(500);
}
const approveUI = (p, id) => click(p, id, '참가 승인', `/applications/${id}/approve`);
const cancelUI = (p, id) => click(p, id, '신청 취소', `/applications/${id}/cancel`);
async function revokeUI(p, id, reason = '운영 사정으로 승인 취소') { await row(p, id).locator('input').fill(reason); await click(p, id, '승인 취소 및 다음 대기자 승급', `/applications/${id}/revoke`); }
async function applyUI(p) { await Promise.all([p.waitForResponse(r => /\/api\/events\/\d+\/applications$/.test(r.url()) && r.request().method() === 'POST'), p.getByRole('button', { name: '참가 신청' }).click()]); await p.waitForTimeout(500); }
async function history(p, id) { await Promise.all([p.waitForResponse(r => r.url().endsWith(`/applications/${id}/history`)), row(p, id).getByRole('button', { name: '변경 이력 보기' }).click()]); await p.waitForTimeout(300); }
const apply = (user, ev = 1) => as(user).then(p => call(p, 'POST', `/api/events/${ev}/applications`, {}));
const act = (user, id, a, body = {}) => as(user).then(p => call(p, 'POST', `/api/applications/${id}/${a}`, body));
const revokeApi = (user, id, reason = '운영 사정으로 승인 취소') => act(user, id, 'revoke', { reason });

const shots = [];
async function shot(p, name, note) {
  await p.evaluate(() => { document.querySelector('details.response').open = true; });
  await p.waitForTimeout(150);
  const seen = await p.evaluate(() => ({ notice: document.querySelector('#notice').textContent, meta: document.querySelector('#response-meta').textContent, who: document.querySelector('#identity').textContent, rows: [...document.querySelectorAll('#applications .app-row')].map(r => r.querySelector('.row').textContent), cap: document.querySelector('#events').innerText.match(/승인 \d+ \/ 정원 \d+명/g) }));
  const file = `${name}.png`; await p.screenshot({ path: path.join(EVID, file), fullPage: true });
  shots.push({ file, note, ...seen }); console.log('  saved', file, '-', note);
}

const S = {};
S.T01 = async () => { const a = await as('alice'); await applyUI(a); await shot(a, 'T01-main', 'alice 신청 201, userId=1, PENDING, Location'); };
S.T02 = async () => {
  const a = await as('alice');
  await call(a, 'POST', '/api/events/1/applications', {}, { token: '', noRefresh: true }); await shot(a, 'T02-main', '토큰 없음 401 TOKEN_REQUIRED');
  await call(a, 'POST', '/api/events/1/applications', {}, { token: 'invalid.jwt.token', noRefresh: true }); await shot(a, 'T02-forged', '위조 토큰 401 INVALID_TOKEN');
  const m = await as('manager1'); await shot(m, 'T02-after', '운영자 목록: 신청 0건 유지');
};
S.T03 = async () => {
  const a = await as('alice');
  for (const b of [{ role: 'MANAGER' }, { status: 'APPROVED' }, { userId: 2 }]) await call(a, 'POST', '/api/events/1/applications', b);
  await shot(a, 'T03-main', 'userId 위조 400 BAD_INPUT (role·status도 400), 신청 없음 유지');
};
S.T04 = async () => {
  await apply('alice'); await apply('alice'); await shot(await as('alice'), 'T04-main', 'PENDING 상태 재신청 409 ALREADY_APPLIED');
  await act('alice', 1, 'cancel'); await apply('alice'); await shot(await as('alice'), 'T04-cancelled', 'CANCELLED 상태 재신청 409');
  await apply('bob'); await act('manager1', 2, 'approve'); await apply('bob'); await shot(await as('bob'), 'T04-approved', 'APPROVED 상태 재신청 409');
  const m = await as('manager1'); await refresh(m); await shot(m, 'T04-after', '운영자 목록: 신청 2건만 존재');
};
S.T05 = async () => { await apply('alice', 1); const a = await as('alice'); await event(a, 2); await applyUI(a); await shot(a, 'T05-main', '행사 2 별도 신청 201'); await event(a, 1); await shot(a, 'T05-event1', '행사 1 신청도 유지'); };
S.T06 = async () => { await apply('alice'); const a = await as('alice'); await refresh(a); await cancelUI(a, 1); await shot(a, 'T06-main', '본인 대기 취소 200, CANCELLED'); };
S.T07 = async () => {
  await apply('alice'); await act('bob', 1, 'cancel'); await shot(await as('bob'), 'T07-main', '타인(bob) 취소 403 FORBIDDEN');
  await act('manager1', 1, 'cancel'); await shot(await as('manager1'), 'T07-manager', '운영자 취소 403, 목록 PENDING 유지');
};
S.T08 = async () => { await apply('alice'); const m = await as('manager1'); await refresh(m); await approveUI(m, 1); await shot(m, 'T08-main', '담당자 승인 200, APPROVED, 승인 1/2'); };
S.T09 = async () => {
  await apply('alice'); await act('alice', 1, 'approve'); await shot(await as('alice'), 'T09-main', '학생 승인 403');
  await act('manager2', 1, 'approve'); await shot(await as('manager2'), 'T09-manager2', '다른 행사 운영자 승인 403');
  const m = await as('manager1'); await refresh(m); await shot(m, 'T09-after', '담당자 목록: PENDING 유지');
};
S.T10 = async () => {
  await apply('alice'); const m = await as('manager1'); await refresh(m); await shot(m, 'T10-stale', '운영자 화면(대기 중) 열어 둠');
  const a = await as('alice'); await cancelUI(a, 1);
  await m.bringToFront(); await approveUI(m, 1); await shot(m, 'T10-main', '오래된 화면 승인 409 INVALID_STATE, CANCELLED 유지');
};
S.T11 = async () => {
  await apply('alice'); await act('manager1', 1, 'approve');
  await act('manager1', 1, 'approve'); await shot(await as('manager1'), 'T11-main', '재승인 409, APPROVED 유지');
  await act('alice', 1, 'cancel'); await shot(await as('alice'), 'T11-student', '학생의 승인 신청 취소 409');
};
S.T12 = async () => { await apply('alice'); const a = await as('alice'); await refresh(a); await cancelUI(a, 1); await act('alice', 1, 'cancel'); await shot(a, 'T12-main', '반복 취소 409, CANCELLED 유지'); };
S.T13 = async () => {
  for (const u of ['alice', 'bob', 'charlie']) await apply(u);
  await act('manager1', 1, 'approve'); await act('manager1', 2, 'approve');
  const m = await as('manager1'); await refresh(m); await approveUI(m, 3); await shot(m, 'T13-main', '정원 초과 409 CAPACITY_FULL, 승인 2/2, charlie PENDING');
};
S.T14 = async () => {
  await apply('manager1'); await shot(await as('manager1'), 'T14-main', '운영자의 신청 403 (역할)');
  await apply('alice', 9999); await shot(await as('alice'), 'T14-notfound', '없는 행사 신청 404');
  await act('manager1', 9999, 'approve'); await shot(await as('manager1'), 'T14-notfound-approve', '없는 신청 승인 404');
  await act('alice', 9999, 'cancel');
  await apply('alice'); await act('alice', 1, 'cancel'); await act('manager2', 1, 'approve'); await shot(await as('manager2'), 'T14-order', '취소된 신청의 비담당 승인 403 (권한이 상태보다 먼저)');
};
S.T15 = async () => {
  const a = await as('alice'); await call(a, 'POST', '/api/events/abc/applications', {}); await shot(a, 'T15-main', "잘못된 ID 'abc' 400 BAD_INPUT");
  await apply('alice'); const b = await as('bob'); await call(b, 'GET', '/api/applications/1'); await shot(b, 'T15-detail', '타인 상세 조회 403');
  await call(await as('manager2'), 'GET', '/api/applications/1'); await shot(await as('manager2'), 'T15-manager2', '비담당 운영자 상세 조회 403');
};
S.T16 = async () => {
  await apply('alice'); await act('manager1', 1, 'approve'); await shot(await as('manager1'), 'T16-before', '재시작 전 APPROVED');
  await restart(); const a = await as('alice'); await history(a, 1); await shot(a, 'T16-main', '서버 재시작·재로그인 후 APPROVED와 이력 유지');
};
S.T17 = async () => {
  await apply('alice'); await act('manager1', 1, 'approve'); const m = await as('manager1'); await refresh(m);
  await revokeUI(m, 1); await shot(m, 'T17-main', '승인 취소 200, REVOKED, promoted=null, 승인 0/2');
  await apply('alice'); await shot(await as('alice'), 'T17-reapply', 'REVOKED 후 재신청 409');
};
async function queue3() { await apply('alice', 2); await act('manager2', 1, 'approve'); await apply('bob', 2); await apply('charlie', 2); }
S.T18 = async () => {
  await queue3(); sql('UPDATE applications SET created_at=? WHERE id=?', '2026-11-02T00:00:00.000Z', 2); sql('UPDATE applications SET created_at=? WHERE id=?', '2026-11-01T00:00:00.000Z', 3);
  const m = await as('manager2'); await event(m, 2); await shot(m, 'T18-before', 'charlie(#3) 신청일이 bob(#2)보다 이름');
  await revokeUI(m, 1); await shot(m, 'T18-main', 'promoted=charlie(#3), bob PENDING 유지');
};
S.T19 = async () => {
  await queue3(); sql("UPDATE applications SET created_at='2026-11-01T00:00:00.000Z' WHERE status='PENDING'");
  const m = await as('manager2'); await event(m, 2); await shot(m, 'T19-before', 'bob·charlie 신청일 동일');
  await revokeUI(m, 1); await shot(m, 'T19-main', '시각 동일 → 작은 ID bob(#2) 승급');
};
S.T20 = async () => {
  await apply('alice', 2); await act('manager2', 1, 'approve'); await apply('bob', 2); await act('bob', 2, 'cancel'); await apply('charlie', 1);
  const m = await as('manager2'); await event(m, 2); await revokeUI(m, 1); await shot(m, 'T20-main', '취소자 bob 제외, promoted=null');
  const m1 = await as('manager1'); await refresh(m1); await shot(m1, 'T20-other', '다른 행사 charlie PENDING 유지');
};
S.T21 = async () => {
  await apply('alice'); await act('manager1', 1, 'approve');
  await revokeApi('alice', 1); await shot(await as('alice'), 'T21-main', '학생 승인 취소 403');
  await revokeApi('bob', 1);
  await revokeApi('manager2', 1); await shot(await as('manager2'), 'T21-manager2', '다른 운영자 승인 취소 403');
  const a = await as('alice'); await call(a, 'POST', '/api/applications/1/revoke', { reason: '운영 사정으로 승인 취소' }, { token: '', noRefresh: true }); await shot(a, 'T21-notoken', '토큰 없음 401');
  const m = await as('manager1'); await refresh(m); await history(m, 1); await shot(m, 'T21-after', 'APPROVED·이력 2건 유지');
};
S.T22 = async () => {
  await apply('alice'); await revokeApi('manager1', 1); await shot(await as('manager1'), 'T22-main', 'PENDING 승인 취소 409');
  await act('alice', 1, 'cancel'); await revokeApi('manager1', 1); await shot(await as('manager1'), 'T22-cancelled', 'CANCELLED 승인 취소 409');
  await apply('bob'); await act('manager1', 2, 'approve'); await revokeApi('manager1', 2); await revokeApi('manager1', 2); await shot(await as('manager1'), 'T22-repeat', '반복 승인 취소 409, REVOKED 유지');
};
S.T23 = async () => {
  await apply('alice'); await act('manager1', 1, 'approve'); const m = await as('manager1');
  for (const b of [{}, { reason: 12 }, { reason: '    ' }, { reason: 'x'.repeat(201) }, { reason: '유효한 취소 사유', actorId: 4 }, { reason: 'abcd' }]) await call(m, 'POST', '/api/applications/1/revoke', b);
  await shot(m, 'T23-main', "4자 사유 400 BAD_INPUT (빈 본문·숫자·공백·201자·추가 필드도 400), APPROVED 유지");
  await revokeUI(m, 1, '  운영 사정으로 취소  '); await history(m, 1); await shot(m, 'T23-history', 'trim된 사유 저장');
};
S.T24 = async () => {
  await apply('alice'); await apply('bob'); await act('alice', 1, 'cancel'); await act('manager1', 2, 'approve');
  const m = await as('manager1'); await refresh(m); await history(m, 1); await shot(m, 'T24-main', 'alice 이력: APPLY(1), CANCEL(1)');
  await history(m, 2); await shot(m, 'T24-bob', 'bob 이력: APPLY(2), APPROVE(3)');
};
S.T25 = async () => {
  await apply('alice'); await act('manager1', 1, 'approve'); await apply('bob');
  const m = await as('manager1'); await refresh(m); await revokeUI(m, 1); await shot(m, 'T25-revoke', '승인 취소 응답 promoted=bob');
  await history(m, 1); await shot(m, 'T25-main', 'alice REVOKE 이력(사유, 행위자 3)');
  await history(m, 2); await shot(m, 'T25-auto', 'bob AUTO_APPROVE 이력, 원인 ID = REVOKE 이력 ID');
};
S.T26 = async () => {
  await apply('alice', 2); await act('manager2', 1, 'approve'); await apply('bob', 2);
  const m2 = await as('manager2'); await event(m2, 2); await approveUI(m2, 2); await shot(m2, 'T26-main', '정원 초과 승인 409 CAPACITY_FULL');
  await apply('alice', 2); await act('alice', 1, 'cancel'); await revokeApi('manager1', 1); await shot(await as('manager1'), 'T26-forbidden', '비담당 승인 취소 403');
  await m2.bringToFront(); await refresh(m2); await history(m2, 2); await shot(m2, 'T26-after', '거부 후 bob 이력 APPLY 1건, 상태 유지');
};
S.T27 = async () => {
  await apply('alice'); const a = await as('alice'); await refresh(a); await history(a, 1); await shot(a, 'T27-main', '본인 이력 조회 200');
  const m = await as('manager1'); await refresh(m); await history(m, 1); await shot(m, 'T27-manager', '담당 운영자 이력 조회 200');
  await call(await as('bob'), 'GET', '/api/applications/1/history', undefined, { noRefresh: true }); await shot(await as('bob'), 'T27-forbidden', '타인 이력 조회 403');
  await call(await as('manager2'), 'GET', '/api/applications/1/history', undefined, { noRefresh: true }); await shot(await as('manager2'), 'T27-manager2', '비담당 운영자 403');
};
S.T28 = async () => {
  trigger('fail_apply', 'APPLY'); const a = await as('alice'); await applyUI(a); await shot(a, 'T28-main', 'APPLY 이력 실패 주입 → 500, 신청 없음');
  const m = await as('manager1'); await refresh(m); await shot(m, 'T28-after', '운영자 목록: 신청 0건 (전체 롤백)');
  sql('DROP TRIGGER fail_apply'); await a.bringToFront(); await refresh(a); await applyUI(a); await shot(a, 'T28-retry', '트리거 제거 후 재신청 201');
};
S.T29 = async () => {
  await apply('alice'); await act('manager1', 1, 'approve'); await apply('bob');
  trigger('fail_auto', 'AUTO_APPROVE'); const m = await as('manager1'); await refresh(m);
  await revokeUI(m, 1); await shot(m, 'T29-main', 'AUTO_APPROVE 이력 실패 주입 → 500, alice APPROVED·bob PENDING 유지');
  await history(m, 1); await shot(m, 'T29-history', 'alice 이력 APPLY·APPROVE만 (REVOKE 롤백)');
  sql('DROP TRIGGER fail_auto'); await refresh(m); await revokeUI(m, 1); await shot(m, 'T29-retry', '재시도 200, promoted=bob');
};
S.T30 = async () => {
  await apply('alice'); await apply('bob'); const m = await as('manager1'); await refresh(m);
  trigger('f', 'APPROVE'); await approveUI(m, 1); await shot(m, 'T30-main', 'APPROVE 이력 실패 → 500, PENDING 유지'); sql('DROP TRIGGER f');
  trigger('f', 'CANCEL'); const b = await as('bob'); await refresh(b); await cancelUI(b, 2); await shot(b, 'T30-cancel', 'CANCEL 이력 실패 → 500, PENDING 유지'); sql('DROP TRIGGER f');
  await m.bringToFront(); await refresh(m); await approveUI(m, 1);
  trigger('f', 'REVOKE'); await revokeUI(m, 1); await shot(m, 'T30-revoke', 'REVOKE 이력 실패 → 500, APPROVED 유지'); sql('DROP TRIGGER f');
};
S.T31 = async () => {
  await apply('alice'); await act('manager1', 1, 'approve'); await apply('bob'); await revokeApi('manager1', 1);
  await restart(); const m = await as('manager1'); await shot(m, 'T31-main', '재시작 후 alice REVOKED, bob APPROVED 유지');
  await history(m, 2); await shot(m, 'T31-history', '재시작 후 bob AUTO_APPROVE 원인 ID 유지');
};
S.T32 = async () => {
  for (const u of ['alice', 'bob', 'charlie']) await apply(u);
  await act('manager1', 1, 'approve'); await act('manager1', 2, 'approve');
  const m = await as('manager1'); await refresh(m);
  await revokeUI(m, 1); await shot(m, 'T32-first', '1차 승인 취소 → charlie 승급');
  await revokeUI(m, 2); await shot(m, 'T32-second', '2차 승인 취소 → promoted=null, 승인 1/2');
  await revokeApi('manager1', 1); await shot(m, 'T32-main', '반복 승인 취소 409, 중복 승급 없음');
};
S.U01 = async () => {
  const a = await as('alice'); await applyUI(a); await shot(a, 'U01-1-apply', 'alice 신청 201');
  const m = await as('manager1'); await approveUI(m, 1); await shot(m, 'U01-2-approve', 'manager1 승인 200, 승인 1/2');
  await a.bringToFront(); await refresh(a); await shot(a, 'U01-3-student', 'alice 새로고침 → 참가 승인');
};
S.U02 = async () => {
  await apply('alice'); const m = await as('manager1'); await shot(m, 'U02-1-stale', '운영자 목록 열어 둠(대기)');
  const a = await as('alice'); await cancelUI(a, 1); await shot(a, 'U02-2-cancel', 'alice 대기 취소 200');
  await m.bringToFront(); await approveUI(m, 1); await shot(m, 'U02-3-rejected', '오래된 화면 승인 409, 대기 취소 유지');
};
S.U03 = async () => {
  await apply('alice'); await act('manager1', 1, 'approve'); const m = await as('manager1'); await history(m, 1); await shot(m, 'U03-1-before', '재시작 전 상태·이력');
  await restart(); const m2 = await as('manager1'); await history(m2, 1); await shot(m2, 'U03-2-after', '서버 종료·재실행·재로그인 후 같은 상태·이력');
};
S.U04 = async () => {
  for (const u of ['alice', 'bob', 'charlie']) { const p = await as(u); await event(p, 2); await applyUI(p); }
  const m = await as('manager2'); await event(m, 2); await shot(m, 'U04-1-queue', '행사 2 신청 3건(alice·bob·charlie)');
  await approveUI(m, 1); await shot(m, 'U04-2-approve', 'alice 승인 1/1');
  await revokeUI(m, 1); await shot(m, 'U04-3-revoke', '승인 취소 → promoted=bob, charlie 대기');
  await history(m, 1); await shot(m, 'U04-4-alice-history', 'alice REVOKE 이력');
  await history(m, 2); await shot(m, 'U04-5-bob-history', 'bob AUTO_APPROVE, 원인 이력 ID 연결');
};
S.U05 = async () => {
  const a = await as('alice'); await event(a, 2); await applyUI(a);
  const m = await as('manager2'); await event(m, 2); await approveUI(m, 1); await revokeUI(m, 1); await shot(m, 'U05-1-revoke', '대기자 없는 승인 취소 → promoted=null, 승인 0/1');
  await history(m, 1); await shot(m, 'U05-2-history', 'alice REVOKED, 이력 APPLY·APPROVE·REVOKE');
};

(async () => {
  browser = await chromium.launch({ executablePath: CHROME });
  ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ko-KR' });
  try {
    for (const [name, fn] of Object.entries(S)) {
      if (only.length && !only.includes(name)) continue;
      console.log(name); await fresh(name); await fn();
    }
  } finally { await stopServer(); await browser.close(); }
  fs.writeFileSync(path.join(__dirname, 'shots.json'), JSON.stringify(shots, null, 1));
})().catch(e => { console.error(e); stopServer().then(() => process.exit(1)); });
