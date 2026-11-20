// Base de dados: executor de migrações, transações (repetição em conflitos, contexto isolado, tempo limite),
// valores grandes, registo de auditoria e criação da primeira conta de administração.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import { bootstrapPlatformAdmin } from '../src/bootstrap';
import { Database, pgCode } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { mapError } from '../src/http/errors-map';
import { audit } from '../src/lib/audit';
import { createLogger } from '../src/lib/log';
import { ADMIN_URL, PASSWORD, seedFullRestaurant, seedPlatformAdmin, seedRestaurant, seedUser, startTestApp, uniqueKey, type TestApp } from './helpers';

async function scratchDb() {
  const name = `t_mig_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  const admin = new SQL({ url: ADMIN_URL, max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.close();
  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  const sql = new SQL({ url, max: 4 });
  return {
    url,
    sql,
    async drop() {
      await sql.close();
      const a = new SQL({ url: ADMIN_URL, max: 1 });
      try {
        await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.close();
      }
    },
  };
}

describe('executor de migrações', () => {
  let dir: string;
  let db: Awaited<ReturnType<typeof scratchDb>>;
  const write = (name: string, text: string) => writeFile(join(dir, name), text);
  const exists = async (table: string) => (await db.sql.unsafe(`SELECT to_regclass('altiora.${table}') IS NOT NULL AS e`))[0].e as boolean;
  const recorded = async () => (await db.sql.unsafe('SELECT name FROM altiora.schema_migrations ORDER BY name')).map((r) => String(r.name));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'altiora-mig-'));
    db = await scratchDb();
  });
  afterAll(async () => {
    await db.drop();
    await rm(dir, { recursive: true, force: true });
  });

  test('aplica por ordem, uma só vez, e ignora ficheiros que não são migrações', async () => {
    await write('0002_segunda.sql', 'CREATE TABLE t2 (id int);');
    await write('0001_primeira.sql', 'CREATE TABLE t1 (id int);');
    await write('README.md', '# nada a ver');
    await write('1_curta.sql', 'DROP SCHEMA altiora CASCADE;'); // nome fora do padrão: nunca corre
    await write('0009_nao.txt', 'DROP SCHEMA altiora CASCADE;');
    const first = await runMigrations(db.sql, dir);
    expect(first.applied).toEqual(['0001_primeira.sql', '0002_segunda.sql']);
    expect(first.alreadyApplied).toEqual([]);
    expect(await exists('t1')).toBe(true);
    expect(await exists('t2')).toBe(true);
    const again = await runMigrations(db.sql, dir);
    expect(again).toEqual({ applied: [], alreadyApplied: ['0001_primeira.sql', '0002_segunda.sql'] });
    expect(await recorded()).toEqual(['0001_primeira.sql', '0002_segunda.sql']);
  });

  test('uma migração nova é aplicada sozinha; editar uma já aplicada é recusado', async () => {
    await write('0003_terceira.sql', 'CREATE TABLE t3 (id int);');
    expect((await runMigrations(db.sql, dir)).applied).toEqual(['0003_terceira.sql']);
    const original = 'CREATE TABLE t1 (id int);';
    await write('0001_primeira.sql', original + '\n-- alterada depois de aplicada\n');
    await expect(runMigrations(db.sql, dir)).rejects.toThrow(/0001_primeira\.sql foi alterada/);
    await write('0001_primeira.sql', original);
    expect((await runMigrations(db.sql, dir)).applied).toEqual([]);
  });

  test('uma migração com erro não deixa nada para trás e não é registada; corrigida, aplica-se', async () => {
    await write('0004_falha.sql', 'CREATE TABLE altiora.antes_do_erro (id int); SELECT * FROM tabela_que_nao_existe;');
    await write('0005_depois.sql', 'CREATE TABLE t5 (id int);');
    await expect(runMigrations(db.sql, dir)).rejects.toThrow();
    expect(await exists('antes_do_erro')).toBe(false);
    expect(await exists('t5')).toBe(false); // a seguinte também não corre
    expect(await recorded()).not.toContain('0004_falha.sql');
    await write('0004_falha.sql', 'CREATE TABLE altiora.antes_do_erro (id int);');
    expect((await runMigrations(db.sql, dir)).applied).toEqual(['0004_falha.sql', '0005_depois.sql']);
    expect(await exists('antes_do_erro')).toBe(true);
  });

  test('o registo das migrações tem a segurança por linha (RLS) ligada', async () => {
    const [r] = await db.sql.unsafe(`SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'altiora.schema_migrations'::regclass`);
    expect(r.rls).toBe(true);
  });

  test('uma pasta sem migrações é um erro claro', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'altiora-mig-vazio-'));
    try {
      await expect(runMigrations(db.sql, empty)).rejects.toThrow(/Nenhuma migração/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test('dois servidores a arrancar ao mesmo tempo: cada migração é aplicada exatamente uma vez', async () => {
    const fresh = await scratchDb();
    const d = await mkdtemp(join(tmpdir(), 'altiora-mig-conc-'));
    const other = new SQL({ url: fresh.url, max: 2 });
    try {
      for (let i = 1; i <= 5; i++) await writeFile(join(d, `000${i}_m${i}.sql`), `CREATE TABLE m${i} (id int); INSERT INTO m${i} VALUES (1);`);
      const [a, b] = await Promise.all([runMigrations(fresh.sql, d), runMigrations(other, d)]);
      const all = [...a.applied, ...b.applied].sort();
      expect(all).toEqual(['0001_m1.sql', '0002_m2.sql', '0003_m3.sql', '0004_m4.sql', '0005_m5.sql']); // sem repetições nem faltas
      const [{ n }] = await fresh.sql.unsafe('SELECT count(*)::int AS n FROM altiora.schema_migrations');
      expect(n).toBe(5);
    } finally {
      await other.close();
      await fresh.drop();
      await rm(d, { recursive: true, force: true });
    }
  });

  test('as migrações reais aplicam-se a uma base vazia, passam a verificação de segurança e podem repetir-se', async () => {
    const fresh = await scratchDb();
    const d = new Database(fresh.url, { max: 2, ssl: 'disable' });
    try {
      const realDir = join(import.meta.dir, '../../db/migrations');
      const first = await runMigrations(d.sql, realDir);
      expect(first.applied.length).toBeGreaterThanOrEqual(2);
      expect(first.applied[0]).toBe('0001_schema.sql');
      expect(await d.selfTest()).toEqual({ ok: true, problems: [] });
      expect(await runMigrations(d.sql, realDir)).toEqual({ applied: [], alreadyApplied: first.applied });
    } finally {
      await d.close();
      await fresh.drop();
    }
  });
});

describe('transações e contexto', () => {
  let t: TestApp;
  let F: Awaited<ReturnType<typeof seedFullRestaurant>>;

  beforeAll(async () => {
    t = await startTestApp();
    F = await seedFullRestaurant(t, 'Base de dados', 'db', { feeBps: 1000 });
  });
  afterAll(async () => {
    await t.close();
  });

  const transient = (code: string) => Object.assign(new Error('falha transitória'), { errno: code });

  test('impasses e conflitos de concorrência repetem a transação (até 3 vezes) e depois desistem', async () => {
    let attempts = 0;
    const value = await t.db.system(async (tx) => {
      attempts++;
      if (attempts < 3) throw transient(attempts === 1 ? '40P01' : '40001');
      return (await tx<{ n: number }>`SELECT 7::int AS n`)[0]!.n;
    });
    expect(value).toBe(7);
    expect(attempts).toBe(3);

    attempts = 0;
    await expect(
      t.db.as({ role: 'manager', restaurantId: F.restaurantId }, async () => {
        attempts++;
        throw transient('40001');
      }),
    ).rejects.toThrow('falha transitória');
    expect(attempts).toBe(4); // a primeira tentativa + 3 repetições
  });

  test('erros normais (ex.: duplicado) não são repetidos', async () => {
    let attempts = 0;
    await expect(
      t.db.system(async () => {
        attempts++;
        throw transient('23505');
      }),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
    attempts = 0;
    await expect(
      t.db.system(async () => {
        attempts++;
        throw new Error('erro qualquer');
      }),
    ).rejects.toThrow('erro qualquer');
    expect(attempts).toBe(1);
  });

  test('o que uma tentativa falhada escreveu é desfeito antes de repetir', async () => {
    let attempts = 0;
    await t.db.system(async (tx) => {
      attempts++;
      await tx`INSERT INTO audit_logs (action) VALUES ('teste.repeticao')`;
      if (attempts === 1) throw transient('40P01');
    });
    expect(attempts).toBe(2);
    const [{ n }] = await t.db.system((tx) => tx<{ n: number }>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'teste.repeticao'`);
    expect(n).toBe(1);
  });

  test('perfil e contexto valem só dentro da transação; a ligação volta limpa ao conjunto de ligações', async () => {
    await t.db.as({ role: 'manager', restaurantId: F.restaurantId, userId: F.userIds.manager }, async (tx) => {
      const [r] = await tx<{ rid: string; uid: string; role: string; cu: string }>`
        SELECT current_setting('app.restaurant_id') AS rid, current_setting('app.user_id') AS uid, current_setting('app.role') AS role, current_user::text AS cu`;
      expect(r).toEqual({ rid: F.restaurantId, uid: F.userIds.manager, role: 'manager', cu: 'altiora_manager' });
      expect(tx.role).toBe('manager');
    });
    const [base] = await t.db.sql.unsafe('SELECT current_user::text AS cu');
    for (let i = 0; i < 16; i++) {
      const [r] = await t.db.system((tx) => tx<{ rid: string | null; uid: string | null; role: string | null; cu: string }>`
        SELECT nullif(current_setting('app.restaurant_id', true), '') AS rid, nullif(current_setting('app.user_id', true), '') AS uid,
               nullif(current_setting('app.role', true), '') AS role, current_user::text AS cu`);
      expect(r).toEqual({ rid: null, uid: null, role: null, cu: base.cu });
    }
  });

  test('perfis desconhecidos e valores de contexto inválidos são recusados antes de chegar à base de dados', async () => {
    await expect(t.db.as({ role: 'admin' as never }, async () => 1)).rejects.toThrow(/Perfil desconhecido/);
    const attempt = (patch: Record<string, unknown>) =>
      t.db.as({ role: 'manager' }, (tx) => tx.setContext(patch)).then(
        () => null,
        (e: Error) => e.message,
      );
    expect(await attempt({ restaurantId: 'nao-uuid' })).toBe('Contexto inválido: restaurantId');
    expect(await attempt({ userId: "'; DROP TABLE users; --" })).toBe('Contexto inválido: userId');
    expect(await attempt({ tableId: '123' })).toBe('Contexto inválido: tableId');
    expect(await attempt({ tableSessionId: 'x' })).toBe('Contexto inválido: tableSessionId');
    expect(await attempt({ publicCode: 'curto' })).toBe('Contexto inválido: publicCode');
    expect(await attempt({ publicCode: 'a b c d e f g h i j k l m n o p' })).toBe('Contexto inválido: publicCode');
    expect(await attempt({ reason: 'x'.repeat(301) })).toBe('Contexto inválido: reason');
    expect(await attempt({ restaurantId: F.restaurantId })).toBeNull();
    expect(await attempt({ restaurantId: null, userId: undefined, reason: null })).toBeNull();
    expect(await attempt({})).toBeNull();
  });

  test('os valores vão sempre como parâmetros: texto com SQL malicioso é só texto', async () => {
    const evil = "x'; DROP TABLE users; --";
    const [r] = await t.db.system((tx) => tx<{ v: string }>`SELECT ${evil}::text AS v`);
    expect(r!.v).toBe(evil);
    const [{ n }] = await t.db.system((tx) => tx<{ n: number }>`SELECT count(*)::int AS n FROM users`);
    expect(n).toBeGreaterThan(0);
  });

  test('com prepare:false não ficam instruções preparadas na sessão (necessário atrás de um «transaction pooler») e o resto continua a funcionar', async () => {
    const without = new Database(t.config.databaseUrl, { max: 1, ssl: 'disable', prepare: false });
    const normal = new Database(t.config.databaseUrl, { max: 1, ssl: 'disable' });
    try {
      const prepared = (d: Database) =>
        d.system(async (tx) => {
          await tx`SELECT ${1}::int AS a`;
          return (await tx<{ n: number }>`SELECT count(*)::int AS n FROM pg_prepared_statements`)[0]!.n;
        });
      expect(await prepared(without)).toBe(0);
      expect(await prepared(normal)).toBeGreaterThan(0);
      // o contexto restrito (perfil + RLS) também funciona
      expect(await without.as({ role: 'public' }, async (tx) => (await tx<{ r: string }>`SELECT current_user AS r`)[0]!.r)).toBe('altiora_public');
      expect(await without.selfTest()).toEqual({ ok: true, problems: [] });
    } finally {
      await without.close();
      await normal.close();
    }
  });

  test('uma consulta lenta é interrompida pelo tempo limite e vira "servidor ocupado" (503)', async () => {
    const slow = new Database(t.config.databaseUrl, { max: 1, ssl: 'disable', statementTimeoutMs: 200 });
    try {
      const started = Date.now();
      const err = await slow.system((tx) => tx`SELECT pg_sleep(3)`).then(() => null, (e: unknown) => e);
      expect(pgCode(err)).toBe('57014');
      expect(Date.now() - started).toBeLessThan(2500);
      expect(mapError(err).error.code).toBe('DB_TIMEOUT');
      // a ligação continua utilizável
      expect(await slow.ping()).toBe(true);
    } finally {
      await slow.close();
    }
  });
});

describe('valores grandes (cêntimos acima de 2^31)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  test('preços até 1 000 000 000 Kz guardam-se e calculam-se sem perda; acima do limite do pedido é recusado', async () => {
    const F = await seedFullRestaurant(t, 'Valores', 'va', { feeBps: 1000 });
    const m = await t.login(F.emails.manager);
    const big = 100_000_000_000; // 1 000 000 000,00 Kz
    const mid = 2_147_483_649; // acima do maior inteiro de 32 bits
    const a = await m.post('/api/menu/items', { category_id: F.menu.categoryId, name: 'Banquete', price_cents: big });
    expect(a.status).toBe(201);
    expect(a.body.item.price_cents).toBe(big);
    const b = await m.post('/api/menu/items', { category_id: F.menu.categoryId, name: 'Médio', price_cents: mid });
    expect(b.status).toBe(201);
    expect(b.body.item.price_cents).toBe(mid);
    expect((await m.post('/api/menu/items', { category_id: F.menu.categoryId, name: 'Demais', price_cents: big + 1 })).status).toBe(400);

    const c = t.anon('203.0.113.70');
    const order = (menu_item_id: string, quantity: number) => c.post(`/api/public/menu/${F.table1.token}/orders`, { items: [{ menu_item_id, quantity }] }, { headers: { 'idempotency-key': uniqueKey() } });

    const one = await order(a.body.item.id, 1);
    expect(one.status).toBe(201);
    expect(one.body.order).toMatchObject({ subtotal_cents: big, service_fee_cents: big / 10, total_cents: big + big / 10 });

    const ten = await order(a.body.item.id, 10); // subtotal = 1 000 000 000 000 (exatamente o limite)
    expect(ten.status).toBe(201);
    expect(ten.body.order).toMatchObject({ subtotal_cents: 1_000_000_000_000, service_fee_cents: 100_000_000_000, total_cents: 1_100_000_000_000 });
    const back = await c.get(`/api/public/orders/${ten.body.order.public_code}`);
    expect(back.body.order.total_cents).toBe(1_100_000_000_000);
    expect(back.body.order.items[0]).toMatchObject({ quantity: 10, unit_price_cents: big, line_total_cents: 1_000_000_000_000 });

    const eleven = await order(a.body.item.id, 11);
    expect(eleven.status).toBe(422);
    expect(eleven.body.error.code).toBe('ORDER_TOO_LARGE');

    const mids = await order(b.body.item.id, 7);
    expect(mids.body.order.subtotal_cents).toBe(mid * 7);
    expect(mids.body.order.service_fee_cents).toBe(Math.round((mid * 7) / 10)); // 1 503 238 554,3 → arredondado
    // a soma de pedidos em curso por mesa mostra-se corretamente aos painéis
    const staff = await t.login(F.emails.waiter);
    const list = await staff.get('/api/orders');
    const totals = list.body.orders.map((o: { total_cents: number }) => o.total_cents).sort((x: number, y: number) => x - y);
    expect(totals).toContain(1_100_000_000_000);
    expect(Number.isSafeInteger(Math.max(...totals))).toBe(true);
  });
});

describe('registo de auditoria', () => {
  let t: TestApp;
  let F: Awaited<ReturnType<typeof seedFullRestaurant>>;
  beforeAll(async () => {
    t = await startTestApp();
    F = await seedFullRestaurant(t, 'Auditoria', 'au');
  });
  afterAll(async () => {
    await t.close();
  });

  test('os dados adicionais ficam como objeto JSON (não como texto), com acentos, listas e níveis', async () => {
    await t.db.system((tx) =>
      audit(tx, {
        restaurantId: F.restaurantId, actorId: F.userIds.manager, actorRole: 'manager', action: 'teste.json', entityType: 'coisa', entityId: 'abc',
        metadata: { nome: 'Açaí 🍇', lista: [1, 2, { a: true }], nulo: null, aninhado: { x: { y: 1 } } }, ip: '203.0.113.5',
      }),
    );
    const [row] = await t.db.system((tx) => tx<Record<string, unknown>>`
      SELECT jsonb_typeof(metadata) AS kind, metadata->>'nome' AS nome, metadata->'lista'->2->>'a' AS flag, metadata->'aninhado'->'x'->>'y' AS y,
             jsonb_typeof(metadata->'nulo') AS nulo, ip, entity_type, entity_id, actor_role
      FROM audit_logs WHERE action = 'teste.json'`);
    expect(row).toEqual({ kind: 'object', nome: 'Açaí 🍇', flag: 'true', y: '1', nulo: 'null', ip: '203.0.113.5', entity_type: 'coisa', entity_id: 'abc', actor_role: 'manager' });
  });

  test('sem dados adicionais guarda-se um objeto vazio; ações sem restaurante (plataforma) também são aceites', async () => {
    await t.db.system(async (tx) => {
      await audit(tx, { restaurantId: null, actorId: null, actorRole: 'platform', action: 'teste.vazio' });
    });
    const [row] = await t.db.system((tx) => tx<{ kind: string; keys: number; rid: string | null }>`
      SELECT jsonb_typeof(metadata) AS kind, (SELECT count(*)::int FROM jsonb_object_keys(metadata)) AS keys, restaurant_id AS rid FROM audit_logs WHERE action = 'teste.vazio'`);
    expect(row).toEqual({ kind: 'object', keys: 0, rid: null });
  });

  test('a auditoria faz parte da transação: se esta falha, o registo também não fica', async () => {
    await expect(
      t.db.system(async (tx) => {
        await audit(tx, { restaurantId: F.restaurantId, actorId: null, actorRole: 'manager', action: 'teste.revertido' });
        throw new Error('falhou depois');
      }),
    ).rejects.toThrow('falhou depois');
    const [{ n }] = await t.db.system((tx) => tx<{ n: number }>`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'teste.revertido'`);
    expect(n).toBe(0);
  });
});

describe('primeira conta de administração (arranque)', () => {
  const quiet = createLogger('error', () => undefined);
  const withAdmin = (t: TestApp, over: Partial<{ email: string; password: string; name: string }> | null) => ({
    ...t.config,
    bootstrapAdmin: over === null ? null : { email: 'root@altiora.test', password: 'Uma-Senha-Forte-2026', name: 'Root', ...over },
  });
  const countAdmins = (t: TestApp) => t.db.system(async (tx) => (await tx<{ n: number }>`SELECT count(*)::int AS n FROM users WHERE is_platform_admin`)[0]!.n);

  test('sem variáveis configuradas não faz nada', async () => {
    const t = await startTestApp();
    try {
      expect(await bootstrapPlatformAdmin(t.db, withAdmin(t, null), quiet)).toBe('skipped');
      expect(await countAdmins(t)).toBe(0);
    } finally {
      await t.close();
    }
  });

  test('cria a conta uma única vez, obriga a trocar a palavra-passe e fica registada', async () => {
    const t = await startTestApp();
    try {
      expect(await bootstrapPlatformAdmin(t.db, withAdmin(t, {}), quiet)).toBe('created');
      expect(await countAdmins(t)).toBe(1);
      // repetir (ex.: o servidor reinicia) não cria outra, nem muda a palavra-passe
      expect(await bootstrapPlatformAdmin(t.db, withAdmin(t, { email: 'outro@altiora.test', password: 'Outra-Senha-Forte-99' }), quiet)).toBe('already-exists');
      expect(await countAdmins(t)).toBe(1);

      const c = await t.login('root@altiora.test', 'Uma-Senha-Forte-2026');
      const me = await c.get('/api/auth/me');
      expect(me.body.user).toMatchObject({ role: 'platform', must_change_password: true, email: 'root@altiora.test' });
      expect((await c.get('/api/admin/restaurants')).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
      expect((await c.post('/api/auth/change-password', { current_password: 'Uma-Senha-Forte-2026', new_password: 'Nova-Senha-Forte-2026' })).status).toBe(204);
      expect((await c.get('/api/admin/restaurants')).status).toBe(200);

      const actions = await t.db.system((tx) => tx<{ action: string; metadata: string }>`SELECT action, metadata::text AS metadata FROM audit_logs WHERE action = 'platform.admin_bootstrap'`);
      expect(actions).toHaveLength(1);
      expect(actions[0]!.metadata).not.toContain('Senha');
    } finally {
      await t.close();
    }
  });

  test('se já existe um administrador da plataforma não cria outro', async () => {
    const t = await startTestApp();
    try {
      await seedPlatformAdmin(t, 'existente@altiora.test');
      expect(await bootstrapPlatformAdmin(t.db, withAdmin(t, {}), quiet)).toBe('already-exists');
      expect(await countAdmins(t)).toBe(1);
    } finally {
      await t.close();
    }
  });

  test('palavra-passe fraca ou e-mail já usado por outra conta: recusa e não cria nada', async () => {
    const t = await startTestApp();
    try {
      expect(await bootstrapPlatformAdmin(t.db, withAdmin(t, { password: 'Password123' }), quiet)).toBe('weak-password'); // palavra-passe comum
      expect(await bootstrapPlatformAdmin(t.db, withAdmin(t, { password: 'Frase-com-root-dentro-1' }), quiet)).toBe('weak-password'); // contém parte do e-mail
      expect(await countAdmins(t)).toBe(0);
      expect(await bootstrapPlatformAdmin(t.db, withAdmin(t, { password: 'Cavalo-Bateria-Agrafo-7' }), quiet)).toBe('created');
      expect(await countAdmins(t)).toBe(1);
    } finally {
      await t.close();
    }
    const t2 = await startTestApp();
    try {
      const rid = await seedRestaurant(t2, 'Restaurante Bootstrap');
      await seedUser(t2, { restaurantId: rid, email: 'root@altiora.test', role: 'manager' });
      expect(await bootstrapPlatformAdmin(t2.db, withAdmin(t2, {}), quiet)).toBe('email-in-use');
      expect(await countAdmins(t2)).toBe(0);
      // a conta de gerente continua a funcionar como antes
      expect((await t2.login('root@altiora.test', PASSWORD)).cookies.size).toBe(1);
    } finally {
      await t2.close();
    }
  });
});

