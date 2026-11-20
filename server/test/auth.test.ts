// Autenticação, sessões, permissões por perfil, proteção contra pedidos forjados (CSRF) e limites de tentativas.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import { sha256Hex } from '../src/lib/crypto';
import { Client, ORIGIN, PASSWORD, seedFullRestaurant, seedPlatformAdmin, seedRestaurant, seedUser, startTestApp, type TestApp } from './helpers';

let t: TestApp;
let A: Awaited<ReturnType<typeof seedFullRestaurant>>;
let B: Awaited<ReturnType<typeof seedFullRestaurant>>;

beforeAll(async () => {
  t = await startTestApp();
  A = await seedFullRestaurant(t, 'Restaurante A', 'a');
  B = await seedFullRestaurant(t, 'Restaurante B', 'b');
  await seedPlatformAdmin(t);
});
afterAll(async () => {
  await t.close();
});

const cookieHeader = (c: Client) => [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');

describe('início de sessão', () => {
  test('sucesso: devolve o utilizador e define um cookie HttpOnly + SameSite (sem o token no corpo)', async () => {
    const c = t.anon();
    const r = await c.post('/api/auth/login', { email: A.emails.manager, password: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe('manager');
    expect(r.body.user.restaurant.name).toBe('Restaurante A');
    expect(r.body.user.must_change_password).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain('password_hash');
    expect(JSON.stringify(r.body)).not.toContain(PASSWORD);
    const sc = r.headers.getSetCookie()[0]!;
    expect(sc).toContain('altiora_sid=');
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Lax');
    expect(sc).toContain('Path=/');
    expect(sc).not.toContain('Secure'); // só em produção (HTTPS)
    // o token em claro nunca fica na base de dados: só o SHA-256
    const token = c.cookies.get('altiora_sid')!;
    expect(token.length).toBe(43);
    const rows = await t.db.system((tx) => tx<{ token_hash: string }>`SELECT token_hash FROM sessions`);
    expect(rows.some((x) => x.token_hash === sha256Hex(token))).toBe(true);
    expect(rows.some((x) => x.token_hash === token)).toBe(false);
  });

  test('em produção o cookie usa o prefixo __Host- e o atributo Secure', async () => {
    const secureApp = createApp({ ...t.deps, config: { ...t.config, cookieSecure: true } });
    const c = new Client(secureApp);
    const r = await c.post('/api/auth/login', { email: A.emails.kitchen, password: PASSWORD });
    expect(r.status).toBe(200);
    const sc = r.headers.getSetCookie()[0]!;
    expect(sc.startsWith('__Host-altiora_sid=')).toBe(true);
    expect(sc).toContain('Secure');
    expect(sc).toContain('Path=/');
    expect(sc).not.toContain('Domain');
    expect((await c.get('/api/auth/me')).status).toBe(200);
  });

  test('credenciais erradas, e-mail inexistente e conta inativa dão exatamente a mesma resposta genérica', async () => {
    await t.db.system((tx) => tx`UPDATE users SET active = false WHERE email = ${B.emails.waiter}`);
    const bad = [
      { email: A.emails.manager, password: 'errada-errada-1' },
      { email: 'ninguem@teste.pt', password: PASSWORD },
      { email: B.emails.waiter, password: PASSWORD },
    ];
    const results = [];
    for (const b of bad) results.push(await t.anon().post('/api/auth/login', b));
    for (const r of results) {
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    expect(new Set(results.map((r) => r.body.error.message)).size).toBe(1);
    expect(results.every((r) => r.headers.getSetCookie().length === 0)).toBe(true);
    await t.db.system((tx) => tx`UPDATE users SET active = true WHERE email = ${B.emails.waiter}`);
  });

  test('o e-mail é normalizado (maiúsculas e espaços)', async () => {
    const r = await t.anon().post('/api/auth/login', { email: `  ${A.emails.waiter.toUpperCase()} `, password: PASSWORD });
    expect(r.status).toBe(200);
  });

  test('dados inválidos → 400 com lista de campos', async () => {
    const r = await t.anon().post('/api/auth/login', { email: 'nao-e-email', password: '' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(r.body.error.details.map((d: any) => d.field).sort()).toEqual(['email', 'password']);
    expect((await t.anon().post('/api/auth/login', { email: A.emails.manager, password: PASSWORD, extra: 1 })).status).toBe(400);
  });

  test('utilizador sem restaurante ou com restaurante suspenso não inicia sessão', async () => {
    const lonely = await seedRestaurant(t, 'Vazio');
    await t.db.system(async (tx) => {
      await tx`INSERT INTO users (email, name, password_hash) SELECT 'solto@teste.pt', 'Solto', password_hash FROM users WHERE email = ${A.emails.manager}`;
    });
    const r1 = await t.anon().post('/api/auth/login', { email: 'solto@teste.pt', password: PASSWORD });
    expect(r1.status).toBe(403);
    expect(r1.body.error.code).toBe('NO_MEMBERSHIP');
    const sus = await seedRestaurant(t, 'Suspenso', { status: 'suspenso' });
    await seedUser(t, { restaurantId: sus, email: 'susp@teste.pt', role: 'manager' });
    const r2 = await t.anon().post('/api/auth/login', { email: 'susp@teste.pt', password: PASSWORD });
    expect(r2.status).toBe(403);
    expect(r2.body.error.code).toBe('RESTAURANT_SUSPENDED');
    void lonely;
  });

  test('o início de sessão fica registado na auditoria (sem a palavra-passe)', async () => {
    const rows = await t.db.system((tx) => tx<{ action: string; metadata: unknown }>`SELECT action, metadata::text AS metadata FROM audit_logs WHERE action IN ('auth.login', 'auth.login_failed')`);
    expect(rows.some((r) => r.action === 'auth.login')).toBe(true);
    expect(rows.some((r) => r.action === 'auth.login_failed')).toBe(true);
    expect(rows.every((r) => !String(r.metadata).includes(PASSWORD))).toBe(true);
  });
});

describe('sessões', () => {
  test('terminar sessão invalida o cookie (mesmo que alguém o guarde)', async () => {
    const c = await t.login(A.emails.manager);
    const saved = cookieHeader(c);
    expect((await c.get('/api/auth/me')).status).toBe(200);
    const out = await c.post('/api/auth/logout');
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie()[0]).toContain('Max-Age=0');
    // reutilizar o cookie antigo
    const replay = t.anon();
    const r = await replay.request('GET', '/api/auth/me', { headers: { cookie: saved } });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('SESSION_EXPIRED');
    expect(r.headers.getSetCookie()[0]).toContain('Max-Age=0'); // limpa o cookie inválido
  });

  test('sessão expirada (inatividade ou limite absoluto) ou revogada → 401', async () => {
    for (const [col, value] of [['expires_at', "now() - interval '1 minute'"], ['absolute_expires_at', "now() - interval '1 minute'"], ['revoked_at', 'now()']] as const) {
      const c = await t.login(A.emails.waiter);
      const token = c.cookies.get('altiora_sid')!;
      expect((await c.get('/api/auth/me')).status).toBe(200);
      await t.db.system((tx) => tx.unsafe(`UPDATE sessions SET ${col} = ${value} WHERE token_hash = $1`, [sha256Hex(token)]));
      const r = await c.get('/api/auth/me');
      expect({ col, status: r.status }).toEqual({ col, status: 401 });
    }
  });

  test('a atividade renova a sessão deslizante até ao limite absoluto', async () => {
    const c = await t.login(A.emails.manager);
    const h = sha256Hex(c.cookies.get('altiora_sid')!);
    await t.db.system((tx) => tx`UPDATE sessions SET last_seen_at = now() - interval '10 minutes', expires_at = now() + interval '1 hour' WHERE token_hash = ${h}`);
    await c.get('/api/auth/me');
    const [s] = await t.db.system((tx) => tx<{ extended: boolean; capped: boolean }>`
      SELECT expires_at > now() + interval '11 hours' AS extended, expires_at <= absolute_expires_at AS capped FROM sessions WHERE token_hash = ${h}`);
    expect(s!.extended).toBe(true);
    expect(s!.capped).toBe(true);
  });

  test('cookies adulterados ou mal formados são recusados', async () => {
    for (const bad of ['x', 'a'.repeat(43), 'a'.repeat(44), '../../etc/passwd', "' OR 1=1 --", '%00']) {
      const r = await t.anon().request('GET', '/api/auth/me', { headers: { cookie: `altiora_sid=${bad}` } });
      expect({ bad, status: r.status }).toEqual({ bad, status: 401 });
    }
  });

  test('uma sessão terminada não afeta a outra sessão do mesmo utilizador', async () => {
    const c1 = await t.login(A.emails.manager);
    const c2 = await t.login(A.emails.manager);
    await c1.post('/api/auth/logout');
    expect((await c2.get('/api/auth/me')).status).toBe(200);
  });
});

describe('palavra-passe', () => {
  test('palavra-passe temporária: só permite trocá-la, ver o perfil e sair, até ser alterada', async () => {
    await seedUser(t, { restaurantId: A.restaurantId, email: 'novo@teste.pt', role: 'waiter', mustChange: true });
    const c = await t.login('novo@teste.pt');
    expect((await c.get('/api/auth/me')).body.user.must_change_password).toBe(true);
    const blocked = await c.get('/api/orders');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await c.get('/api/tables')).status).toBe(403);

    const weak = await c.post('/api/auth/change-password', { current_password: PASSWORD, new_password: 'curta' });
    expect(weak.status).toBe(422);
    expect(weak.body.error.code).toBe('WEAK_PASSWORD');
    expect((await c.post('/api/auth/change-password', { current_password: PASSWORD, new_password: 'novo@teste.pt1234' })).body.error.code).toBe('WEAK_PASSWORD');
    expect((await c.post('/api/auth/change-password', { current_password: PASSWORD, new_password: 'password123' })).body.error.code).toBe('WEAK_PASSWORD');
    const wrong = await c.post('/api/auth/change-password', { current_password: 'errada-errada-1', new_password: 'Outra-Senha-98765' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('WRONG_CURRENT_PASSWORD');
    expect((await c.post('/api/auth/change-password', { current_password: PASSWORD, new_password: PASSWORD })).body.error.code).toBe('SAME_PASSWORD');

    const other = await t.login('novo@teste.pt'); // outra sessão do mesmo utilizador
    const ok = await c.post('/api/auth/change-password', { current_password: PASSWORD, new_password: 'Outra-Senha-98765' });
    expect(ok.status).toBe(204);
    expect((await c.get('/api/orders')).status).toBe(200);
    // a outra sessão foi terminada
    expect((await other.get('/api/auth/me')).status).toBe(401);
    // a palavra-passe antiga deixou de servir; a nova serve
    expect((await t.anon().post('/api/auth/login', { email: 'novo@teste.pt', password: PASSWORD })).status).toBe(401);
    expect((await t.anon().post('/api/auth/login', { email: 'novo@teste.pt', password: 'Outra-Senha-98765' })).status).toBe(200);
  });

  test('a palavra-passe fica guardada só como hash scrypt', async () => {
    const [u] = await t.db.system((tx) => tx<{ password_hash: string }>`SELECT password_hash FROM users WHERE email = ${A.emails.manager}`);
    expect(u!.password_hash.startsWith('scrypt$')).toBe(true);
    expect(u!.password_hash).not.toContain(PASSWORD);
  });
});

describe('permissões por perfil (todas as rotas)', () => {
  const sample = (path: string) => path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');

  test('qualquer rota que não seja pública responde 401 sem sessão', async () => {
    const anon = t.anon();
    const protectedRoutes = t.app.router.list().filter((r) => r.access !== 'public');
    expect(protectedRoutes.length).toBeGreaterThan(25);
    for (const r of protectedRoutes) {
      const res = await anon.request(r.method, sample(r.path), { json: r.method === 'GET' || r.noBody ? undefined : {} });
      expect({ route: `${r.method} ${r.path}`, status: res.status }).toEqual({ route: `${r.method} ${r.path}`, status: 401 });
    }
  });

  test('cada perfil só chega às rotas do seu perfil (403 nas restantes), incluindo o administrador da plataforma', async () => {
    const clients: Record<string, Client> = {
      kitchen: await t.login(A.emails.kitchen),
      waiter: await t.login(A.emails.waiter),
      manager: await t.login(A.emails.manager),
      platform: await t.login('admin@altiora.test'),
    };
    const failures: string[] = [];
    for (const r of t.app.router.list()) {
      if (r.access === 'public') continue;
      for (const [role, c] of Object.entries(clients)) {
        const allowed = r.access === 'session' ? true : r.access === 'platform' ? role === 'platform' : r.access.roles.includes(role as never);
        if (allowed) continue; // as rotas permitidas são testadas nos testes funcionais
        // (logout só termina a própria sessão — não está em causa aqui porque é 'session')
        const res = await c.request(r.method, sample(r.path), { json: r.method === 'GET' || r.noBody ? undefined : {} });
        if (res.status !== 403) failures.push(`${role} ${r.method} ${r.path} → ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('o administrador da plataforma não vê pedidos nem menus de nenhum restaurante', async () => {
    const admin = await t.login('admin@altiora.test');
    const me = await admin.get('/api/auth/me');
    expect(me.body.user.role).toBe('platform');
    expect(me.body.user.restaurant).toBeNull();
    for (const p of ['/api/orders', '/api/menu', '/api/tables', '/api/restaurants/current']) {
      expect({ p, status: (await admin.get(p)).status }).toEqual({ p, status: 403 });
    }
    expect((await admin.get('/api/admin/restaurants')).status).toBe(200);
  });

  test('restaurante suspenso: as sessões em curso deixam de aceder (exceto perfil e terminar sessão)', async () => {
    const rid = await seedRestaurant(t, 'A Suspender');
    await seedUser(t, { restaurantId: rid, email: 'sus.gerente@teste.pt', role: 'manager' });
    const c = await t.login('sus.gerente@teste.pt');
    expect((await c.get('/api/menu')).status).toBe(200);
    await t.db.system((tx) => tx`UPDATE restaurants SET status = 'suspenso' WHERE id = ${rid}`);
    const r = await c.get('/api/menu');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('RESTAURANT_SUSPENDED');
    expect((await c.get('/api/auth/me')).status).toBe(200);
    expect((await c.post('/api/auth/logout')).status).toBe(204);
  });

  test('utilizador desativado ou removido da equipa perde o acesso de imediato', async () => {
    await seedUser(t, { restaurantId: A.restaurantId, email: 'saiu@teste.pt', role: 'kitchen' });
    const c = await t.login('saiu@teste.pt');
    expect((await c.get('/api/orders')).status).toBe(200);
    await t.db.system((tx) => tx`UPDATE restaurant_members SET active = false WHERE user_id = (SELECT id FROM users WHERE email = 'saiu@teste.pt')`);
    expect((await c.get('/api/orders')).status).toBe(401);
    // sem associação ativa nem sequer volta a iniciar sessão
    expect((await t.anon().post('/api/auth/login', { email: 'saiu@teste.pt', password: PASSWORD })).status).toBe(403);
    await t.db.system((tx) => tx`UPDATE restaurant_members SET active = true WHERE user_id = (SELECT id FROM users WHERE email = 'saiu@teste.pt')`);
    const again = await t.login('saiu@teste.pt');
    expect((await again.get('/api/orders')).status).toBe(200);
    // conta desativada: a sessão em curso deixa de funcionar
    await t.db.system((tx) => tx`UPDATE users SET active = false WHERE email = 'saiu@teste.pt'`);
    expect((await again.get('/api/orders')).status).toBe(401);
  });
});

describe('vários restaurantes', () => {
  test('o utilizador troca de restaurante e o perfil muda; não pode trocar para um restaurante alheio', async () => {
    const ra = await seedRestaurant(t, 'Alfa Multi');
    const rb = await seedRestaurant(t, 'Beta Multi');
    const uid = await seedUser(t, { restaurantId: ra, email: 'multi@teste.pt', role: 'waiter' });
    await t.db.system((tx) => tx`INSERT INTO restaurant_members (restaurant_id, user_id, role) VALUES (${rb}, ${uid}, 'kitchen')`);
    const c = await t.login('multi@teste.pt');
    const me = await c.get('/api/auth/me');
    expect(me.body.user.restaurant.name).toBe('Alfa Multi');
    expect(me.body.user.role).toBe('waiter');
    expect(me.body.user.memberships).toHaveLength(2);
    expect((await c.get('/api/orders')).status).toBe(200);

    const sw = await c.post('/api/auth/switch-restaurant', { restaurant_id: rb });
    expect(sw.status).toBe(200);
    expect(sw.body.user.restaurant.name).toBe('Beta Multi');
    expect(sw.body.user.role).toBe('kitchen');
    expect((await c.post('/api/orders', { table_id: A.table1.id, items: [] })).status).toBe(403); // cozinha não cria pedidos

    const foreign = await c.post('/api/auth/switch-restaurant', { restaurant_id: A.restaurantId });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('NOT_A_MEMBER');
    expect((await c.get('/api/auth/me')).body.user.restaurant.name).toBe('Beta Multi');
  });
});

describe('proteção contra pedidos forjados (CSRF) e formato dos pedidos', () => {
  test('um site externo não consegue fazer o navegador do utilizador alterar dados', async () => {
    const c = await t.login(A.emails.manager);
    const evil = await c.post('/api/tables', { table_number: 70 }, { headers: { origin: 'http://evil.test' } });
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    const cross = await c.post('/api/tables', { table_number: 70 }, { noOrigin: true, headers: { 'sec-fetch-site': 'cross-site' } });
    expect(cross.status).toBe(403);
    // do próprio site: aceite
    expect((await c.post('/api/tables', { table_number: 70 })).status).toBe(201);
    // clientes sem navegador (sem Origin e sem Sec-Fetch-Site) funcionam
    expect((await c.post('/api/tables', { table_number: 71 }, { noOrigin: true })).status).toBe(201);
    // nada foi criado pelos pedidos forjados
    const n = await t.db.system(async (tx) => (await tx<{ n: number }>`SELECT count(*)::int AS n FROM restaurant_tables WHERE table_number IN (70, 71) AND restaurant_id = ${A.restaurantId}`)[0]!.n);
    expect(n).toBe(2);
  });

  test('origens autorizadas (ALLOWED_ORIGINS) funcionam e recebem cabeçalhos CORS; as restantes não', async () => {
    const t2 = await startTestApp({ env: { ALLOWED_ORIGINS: 'https://menu.exemplo.ao' } });
    try {
      const rid = await seedRestaurant(t2, 'Cors');
      await seedUser(t2, { restaurantId: rid, email: 'cors@teste.pt', role: 'manager' });
      const c = new Client(t2.app);
      const login = await c.post('/api/auth/login', { email: 'cors@teste.pt', password: PASSWORD }, { headers: { origin: 'https://menu.exemplo.ao' } });
      expect(login.status).toBe(200);
      expect(login.headers.get('access-control-allow-origin')).toBe('https://menu.exemplo.ao');
      expect(login.headers.get('access-control-allow-credentials')).toBe('true');
      expect((await c.post('/api/tables', { table_number: 1 }, { headers: { origin: 'https://menu.exemplo.ao' } })).status).toBe(201);
      const evil = await c.post('/api/tables', { table_number: 2 }, { headers: { origin: 'https://evil.exemplo.ao' } });
      expect(evil.status).toBe(403);
      expect(evil.headers.get('access-control-allow-origin')).toBeNull();
      // pré-verificação (preflight)
      const pre = await c.request('OPTIONS', '/api/orders', { headers: { origin: 'https://menu.exemplo.ao', 'access-control-request-method': 'POST' } });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('access-control-allow-origin')).toBe('https://menu.exemplo.ao');
      expect(pre.headers.get('access-control-allow-headers')).toContain('Idempotency-Key');
      const preEvil = await c.request('OPTIONS', '/api/orders', { headers: { origin: 'https://evil.exemplo.ao' } });
      expect(preEvil.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await t2.close();
    }
  });

  test('o corpo tem de ser JSON, válido e pequeno', async () => {
    const c = t.anon();
    expect((await c.request('POST', '/api/auth/login', { body: 'email=a&password=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status).toBe(415);
    expect((await c.request('POST', '/api/auth/login', { body: JSON.stringify({ email: 'a@b.pt', password: 'x' }) })).status).toBe(415); // sem Content-Type
    const bad = await c.request('POST', '/api/auth/login', { body: '{nao-e-json', headers: { 'content-type': 'application/json' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
    expect((await c.request('POST', '/api/auth/login', { body: '', headers: { 'content-type': 'application/json' } })).status).toBe(400);
    const big = await c.request('POST', '/api/auth/login', { body: JSON.stringify({ email: 'a@b.pt', password: 'x'.repeat(70_000) }), headers: { 'content-type': 'application/json' } });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    // UTF-8 inválido
    const raw = await c.request('POST', '/api/auth/login', { body: new TextDecoder('latin1').decode(new Uint8Array([123, 34, 0xe9, 34, 125])), headers: { 'content-type': 'application/json' } });
    expect([400]).toContain(raw.status);
  });
});

describe('limite de tentativas de início de sessão', () => {
  test('depois de falhas repetidas o início de sessão é bloqueado temporariamente (mesmo com a palavra-passe certa)', async () => {
    const t2 = await startTestApp({ env: { RATE_LIMIT_ENABLED: 'true' } });
    try {
      const rid = await seedRestaurant(t2, 'Throttle');
      await seedUser(t2, { restaurantId: rid, email: 'thr@teste.pt', role: 'manager' });
      const attacker = new Client(t2.app, '203.0.113.50');
      for (let i = 0; i < 6; i++) {
        const r = await attacker.post('/api/auth/login', { email: 'thr@teste.pt', password: `errada-${i}-errada` });
        expect(r.status).toBe(401);
      }
      const locked = await attacker.post('/api/auth/login', { email: 'thr@teste.pt', password: PASSWORD });
      expect(locked.status).toBe(429);
      expect(locked.body.error.code).toBe('LOGIN_LOCKED');
      expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
      // o dono legítimo, a partir de outra rede, continua a entrar
      const owner = new Client(t2.app, '198.51.100.99');
      expect((await owner.post('/api/auth/login', { email: 'thr@teste.pt', password: PASSWORD })).status).toBe(200);
    } finally {
      await t2.close();
    }
  });

  test('um endereço IP que testa muitos e-mails também é bloqueado', async () => {
    const t2 = await startTestApp({ env: { RATE_LIMIT_ENABLED: 'true' } });
    try {
      const c = new Client(t2.app, '203.0.113.77');
      let blocked = 0;
      for (let i = 0; i < 60; i++) {
        const r = await c.post('/api/auth/login', { email: `alvo${i}@teste.pt`, password: 'qualquer-coisa-1' });
        if (r.status === 429) blocked++;
      }
      expect(blocked).toBeGreaterThan(10);
    } finally {
      await t2.close();
    }
  });
});

void ORIGIN;
