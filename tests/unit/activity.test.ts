/** Activity log: labels, categories, date filters, paging, safe details and links. Disposable storage. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const storage = mkdtempSync(join(tmpdir(), 'vk-unit-test-activity-'));
process.env.STORAGE_DIR = storage;
const { getDb, closeDb } = await import('../../src/lib/server/db.ts');
const { audit } = await import('../../src/lib/server/audit.ts');
const V = await import('../../src/lib/server/activity.ts');

after(() => {
  closeDb();
  rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Every audit action written anywhere in src/ or scripts/. */
function actionsInSource(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|astro|mjs)$/.test(n) ? [p] : [];
    });
  for (const file of [...walk('src'), ...walk('scripts')]) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/audit\(\s*(?:[\w.]+\s*\?\s*)?'([a-z_.]+)'(?:\s*:\s*'([a-z_.]+)')?/g)) {
      found.add(m[1]);
      if (m[2]) found.add(m[2]);
    }
  }
  return found;
}

const insert = (action: string, at: string, extra: { targetType?: string; targetId?: string; detail?: unknown } = {}) =>
  getDb()
    .prepare('INSERT INTO audit_log (at, user_id, action, target_type, target_id, detail) VALUES (?, NULL, ?, ?, ?, ?)')
    .run(at, action, extra.targetType ?? null, extra.targetId ?? null, extra.detail === undefined ? null : JSON.stringify(extra.detail));

test('every action recorded anywhere in the code has a readable label and an area', () => {
  const actions = actionsInSource();
  assert.ok(actions.size >= 30, `found ${actions.size} actions`);
  for (const a of actions) {
    assert.ok(V.ACTION_LABELS[a], `missing label for ${a}`);
    assert.ok(V.categoryOf(a), `no area for ${a}`);
  }
});

test('area filters in SQL match the area rules', () => {
  getDb().exec('DELETE FROM audit_log');
  const actions = Object.keys(V.ACTION_LABELS);
  actions.forEach((a, i) => insert(a, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()));
  for (const cat of Object.keys(V.CATEGORIES) as (keyof typeof V.CATEGORIES)[]) {
    const expected = actions.filter((a) => V.categoryOf(a) === cat).sort();
    const got = V.listActivity({ category: cat }).rows.map((r) => r.action).sort();
    assert.deepEqual(got, expected, cat);
  }
  assert.equal(V.listActivity().total, actions.length);
  assert.equal(V.listActivity({ category: 'nonsense' as never }).total, actions.length, 'unknown area ignored');
});

test('date range is inclusive by day (server time zone) and invalid dates are ignored', () => {
  getDb().exec('DELETE FROM audit_log');
  const local = (y: number, m: number, d: number, h: number) => new Date(y, m - 1, d, h).toISOString();
  insert('login.success', local(2026, 3, 9, 23));
  insert('login.success', local(2026, 3, 10, 0));
  insert('login.success', local(2026, 3, 10, 23));
  insert('login.success', local(2026, 3, 11, 0));
  assert.equal(V.listActivity({ from: '2026-03-10', to: '2026-03-10' }).total, 2);
  assert.equal(V.listActivity({ from: '2026-03-10' }).total, 3);
  assert.equal(V.listActivity({ to: '2026-03-09' }).total, 1);
  const bad = V.listActivity({ from: '2026-02-31', to: "2026-03-10' OR 1=1 --" });
  assert.equal(bad.total, 4, 'invalid dates ignored, never interpolated');
  assert.equal(bad.from, null);
  assert.equal(bad.to, null);
});

test('newest first, 50 per page, page numbers clamped', () => {
  getDb().exec('DELETE FROM audit_log');
  for (let i = 0; i < 120; i++) insert('backup.verify', new Date(Date.UTC(2026, 4, 1, 0, 0, i)).toISOString(), { detail: { n: i } });
  const p1 = V.listActivity();
  assert.equal(p1.pages, 3);
  assert.equal(p1.rows.length, V.ACTIVITY_PAGE_SIZE);
  assert.equal(p1.rows[0].details[0].value, '119', 'newest first');
  assert.equal(V.listActivity({ page: 3 }).rows.length, 20);
  assert.equal(V.listActivity({ page: 99 }).page, 3);
  assert.equal(V.listActivity({ page: -4 }).page, 1);
});

test('details show simple values only; sensitive-looking keys are never displayed', () => {
  const d = V.safeDetails(
    JSON.stringify({
      kind: 'stat',
      changed: ['email', 'hours'],
      count: 2,
      ok: true,
      password: 'x',
      csrfToken: 'x',
      session_id: 'x',
      email: 'someone@example.com',
      phone: '+910000000000',
      name: 'Someone',
      message: 'hello',
      ip: '127.0.0.1',
      nested: { a: 1 },
      'bad key': 'x',
      longList: Array(50).fill('ab'),
    }),
  );
  assert.deepEqual(
    d.map((x) => x.key),
    ['kind', 'changed', 'count', 'ok', 'longList'],
  );
  assert.equal(d.find((x) => x.key === 'changed')!.value, 'email, hours', 'field names (not values) are fine');
  assert.ok(!JSON.stringify(d).includes('someone@example.com'));
  assert.deepEqual(V.safeDetails('not json'), []);
  assert.deepEqual(V.safeDetails('[1,2]'), []);
});

test('links point only at items that still exist; CLI usernames are never shown as targets', () => {
  getDb().exec('DELETE FROM audit_log');
  const now = new Date().toISOString();
  const media = Number(
    getDb()
      .prepare("INSERT INTO media (uid, original_name, source_format, width, height, bytes, created_at, updated_at) VALUES (?, '', 'png', 1, 1, 1, ?, ?)")
      .run('00000000-0000-4000-8000-000000000001', now, now).lastInsertRowid,
  );
  insert('media.upload', now, { targetType: 'media', targetId: String(media) });
  insert('media.delete', now, { targetType: 'media', targetId: '999999' });
  insert('content.publish', now, { targetType: 'content', targetId: '1' });
  insert('admin.password_reset_cli', now, { targetType: 'admin', targetId: 'some-admin-name' });
  const rows = V.listActivity().rows;
  const by = (a: string) => rows.find((r) => r.action === a)!;
  assert.equal(by('media.upload').link, `/admin/media/${media}`);
  assert.equal(by('media.delete').link, null, 'deleted item: no link');
  assert.equal(by('content.publish').link, '/admin/site-content');
  assert.equal(by('admin.password_reset_cli').targetId, null);
  assert.equal(by('admin.password_reset_cli').targetType, null);
  assert.ok(!JSON.stringify(rows).includes('some-admin-name'));
});

test('audit entries written through audit() appear with labels', () => {
  getDb().exec('DELETE FROM audit_log');
  audit('account.password_changed', { userId: null, targetType: 'account', targetId: 1 });
  const r = V.listActivity({ category: 'account' }).rows;
  assert.equal(r.length, 1);
  assert.equal(r[0].label, 'Password changed');
});
