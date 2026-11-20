// Equipa do restaurante: só o gerente gere contas; cada gerente só vê e altera a sua própria equipa.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client, PASSWORD, seedFullRestaurant, seedPlatformAdmin, seedRestaurant, seedUser, startTestApp, type TestApp } from './helpers';

let t: TestApp;
let A: Awaited<ReturnType<typeof seedFullRestaurant>>;
let B: Awaited<ReturnType<typeof seedFullRestaurant>>;
let manager: Client;
let managerB: Client;
let waiter: Client;
let kitchen: Client;
let customer: Client;

beforeAll(async () => {
  t = await startTestApp();
  A = await seedFullRestaurant(t, 'Terraza A', 'a');
  B = await seedFullRestaurant(t, 'Restaurante B', 'b');
  manager = await t.login(A.emails.manager);
  managerB = await t.login(B.emails.manager);
  waiter = await t.login(A.emails.waiter);
  kitchen = await t.login(A.emails.kitchen);
  customer = t.anon('203.0.113.60');
});
afterAll(async () => {
  await t.close();
});

const login = (email: string, password: string) => t.anon('203.0.113.61').post('/api/auth/login', { email, password });
const auditOf = (rid: string, action: string) => t.db.system(async (tx) => tx<{ metadata: any; entity_id: string }>`SELECT metadata, entity_id FROM audit_logs WHERE restaurant_id = ${rid} AND action = ${action} ORDER BY id`);

describe('listar a equipa', () => {
  test('só o gerente vê a equipa, e só a do seu restaurante', async () => {
    for (const c of [customer, waiter, kitchen]) expect([401, 403]).toContain((await c.get('/api/staff')).status);
    const r = await manager.get('/api/staff');
    expect(r.status).toBe(200);
    expect(r.body.members.map((m: any) => m.email).sort()).toEqual([A.emails.kitchen, A.emails.manager, A.emails.waiter].sort());
    expect(r.body.members.find((m: any) => m.is_self).email).toBe(A.emails.manager);
    // nunca devolve dados de acesso
    expect(JSON.stringify(r.body)).not.toMatch(/password_hash|"password"|token|secret|scrypt/i);
    const rb = await managerB.get('/api/staff');
    expect(rb.body.members.map((m: any) => m.email)).not.toContain(A.emails.waiter);
  });
});

describe('criar contas', () => {
  test('o gerente cria um empregado com palavra-passe temporária que tem de ser trocada no primeiro acesso', async () => {
    const r = await manager.post('/api/staff', { name: '  Joana Empregada ', email: 'Joana@Teste.PT', role: 'waiter' });
    expect(r.status).toBe(201);
    expect(r.body.member).toMatchObject({ name: 'Joana Empregada', email: 'joana@teste.pt', role: 'waiter', active: true, must_change_password: true, is_self: false });
    const temp = r.body.temporary_password as string;
    expect(temp).toMatch(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/);

    const first = await login('joana@teste.pt', temp);
    expect(first.status).toBe(200);
    expect(first.body.user.must_change_password).toBe(true);
    // enquanto não trocar a palavra-passe, o resto da API está fechado
    const c = new Client(t.app, '203.0.113.62');
    await c.post('/api/auth/login', { email: 'joana@teste.pt', password: temp });
    expect((await c.get('/api/orders')).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const changed = await c.post('/api/auth/change-password', { current_password: temp, new_password: 'Nova-Senha-Forte-2026' });
    expect(changed.status).toBe(204);
    expect((await c.get('/api/orders')).status).toBe(200);
    // a palavra-passe temporária deixou de servir
    expect((await login('joana@teste.pt', temp)).status).toBe(401);
  });

  test('a palavra-passe temporária nunca fica na auditoria nem na base de dados em claro', async () => {
    const r = await manager.post('/api/staff', { name: 'Rui Cozinheiro', email: 'rui@teste.pt', role: 'kitchen' });
    const temp = r.body.temporary_password as string;
    const logs = await auditOf(A.restaurantId, 'staff.create');
    expect(JSON.stringify(logs)).not.toContain(temp);
    const rows = await t.db.system(async (tx) => tx<{ password_hash: string }>`SELECT password_hash FROM users WHERE email = 'rui@teste.pt'`);
    expect(rows[0]!.password_hash).not.toContain(temp);
    expect(logs.at(-1)!.metadata).toMatchObject({ role: 'kitchen', email: 'rui@teste.pt' });
  });

  test('e-mails repetidos (qualquer restaurante, qualquer capitalização) são recusados', async () => {
    expect((await manager.post('/api/staff', { name: 'Outra', email: 'JOANA@teste.pt', role: 'waiter' })).body.error.code).toBe('EMAIL_TAKEN');
    expect((await manager.post('/api/staff', { name: 'Intruso', email: B.emails.waiter, role: 'waiter' })).body.error.code).toBe('EMAIL_TAKEN');
    // o administrador da plataforma também não pode ser "adotado" por um gerente
    await seedPlatformAdmin(t, 'plataforma@altiora.test');
    expect((await manager.post('/api/staff', { name: 'Admin', email: 'plataforma@altiora.test', role: 'manager' })).status).toBe(409);
  });

  test('dados inválidos e perfis inexistentes', async () => {
    for (const body of [
      {},
      { name: 'X', email: 'sem-arroba', role: 'waiter' },
      { name: '', email: 'x@teste.pt', role: 'waiter' },
      { name: 'X', email: 'x@teste.pt', role: 'platform' },
      { name: 'X', email: 'x@teste.pt', role: 'admin' },
      { name: 'X', email: 'x@teste.pt', role: 'waiter', is_platform_admin: true },
      { name: 'X', email: 'x@teste.pt', role: 'waiter', password: 'abc' },
    ]) {
      expect((await manager.post('/api/staff', body)).status).toBe(400);
    }
  });

  test('só o gerente cria contas', async () => {
    const body = { name: 'Intruso', email: 'intruso@teste.pt', role: 'manager' };
    for (const c of [customer, waiter, kitchen]) expect([401, 403]).toContain((await c.post('/api/staff', body)).status);
    const rows = await t.db.system(async (tx) => tx`SELECT 1 FROM users WHERE email = 'intruso@teste.pt'`);
    expect(rows).toHaveLength(0);
  });
});

describe('alterar perfil e desativar', () => {
  let userId: string;
  let tempPassword: string;
  let session: Client;

  test('desativar termina o acesso de imediato, mesmo com a sessão aberta', async () => {
    const r = await manager.post('/api/staff', { name: 'Marta', email: 'marta@teste.pt', role: 'waiter' });
    userId = r.body.member.user_id;
    tempPassword = r.body.temporary_password;
    session = new Client(t.app, '203.0.113.63');
    await session.post('/api/auth/login', { email: 'marta@teste.pt', password: tempPassword });
    await session.post('/api/auth/change-password', { current_password: tempPassword, new_password: 'Cadeira-Verde-Lago-71' });
    expect((await session.get('/api/orders')).status).toBe(200);

    const off = await manager.patch(`/api/staff/${userId}`, { active: false });
    expect(off.status).toBe(200);
    expect(off.body.member.active).toBe(false);
    expect((await session.get('/api/orders')).status).toBe(401);
    expect([401, 403]).toContain((await login('marta@teste.pt', 'Cadeira-Verde-Lago-71')).status);
    expect((await auditOf(A.restaurantId, 'staff.update')).at(-1)!.metadata).toEqual({ active: { from: true, to: false } });
  });

  test('voltar a ativar devolve o acesso; mudar o perfil vale logo', async () => {
    expect((await manager.patch(`/api/staff/${userId}`, { active: true })).status).toBe(200);
    const again = await login('marta@teste.pt', 'Cadeira-Verde-Lago-71');
    expect(again.status).toBe(200);
    expect(again.body.user.role).toBe('waiter');
    const c = new Client(t.app, '203.0.113.64');
    await c.post('/api/auth/login', { email: 'marta@teste.pt', password: 'Cadeira-Verde-Lago-71' });
    expect((await c.post('/api/menu/categories', { name: 'Tentativa' })).status).toBe(403);
    expect((await manager.patch(`/api/staff/${userId}`, { role: 'manager' })).body.member.role).toBe('manager');
    expect((await c.post('/api/menu/categories', { name: 'Tentativa da Marta' })).status).toBe(201);
    expect((await manager.patch(`/api/staff/${userId}`, { role: 'kitchen' })).body.member.role).toBe('kitchen');
    expect((await c.post('/api/menu/categories', { name: 'Outra tentativa' })).status).toBe(403);
  });

  test('ninguém altera a própria conta; pedidos vazios ou inválidos são recusados', async () => {
    const self = await manager.patch(`/api/staff/${A.userIds.manager}`, { active: false });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('CANNOT_EDIT_SELF');
    expect((await manager.patch(`/api/staff/${A.userIds.manager}`, { role: 'waiter' })).status).toBe(403);
    expect((await manager.get('/api/staff')).body.members.find((m: any) => m.is_self).role).toBe('manager');
    expect((await manager.patch(`/api/staff/${userId}`, {})).status).toBe(400);
    expect((await manager.patch(`/api/staff/${userId}`, { role: 'platform' })).status).toBe(400);
    expect((await manager.patch(`/api/staff/${userId}`, { name: 'Outro nome' })).status).toBe(400);
    expect((await manager.patch('/api/staff/nao-e-um-id', { active: false })).status).toBe(404);
  });

  test('o restaurante nunca fica sem gerente: um gerente não se desativa a si próprio, mas pode desativar outro', async () => {
    const r = await manager.post('/api/staff', { name: 'Segundo Gerente', email: 'gerente2@teste.pt', role: 'manager' });
    const second = r.body.member.user_id;
    expect((await manager.patch(`/api/staff/${second}`, { active: false })).status).toBe(200);
    expect((await manager.patch(`/api/staff/${second}`, { active: true })).status).toBe(200);
  });
});

describe('repor palavras-passe', () => {
  test('o gerente repõe a de um empregado: a antiga deixa de servir e as sessões terminam', async () => {
    const created = await manager.post('/api/staff', { name: 'Paulo', email: 'paulo@teste.pt', role: 'waiter' });
    const uid = created.body.member.user_id;
    const s = new Client(t.app, '203.0.113.65');
    await s.post('/api/auth/login', { email: 'paulo@teste.pt', password: created.body.temporary_password });
    await s.post('/api/auth/change-password', { current_password: created.body.temporary_password, new_password: 'Janela-Azul-Rio-52' });
    expect((await s.get('/api/orders')).status).toBe(200);

    const r = await manager.post(`/api/staff/${uid}/reset-password`);
    expect(r.status).toBe(200);
    expect(r.body.email).toBe('paulo@teste.pt');
    expect(r.body.temporary_password).toMatch(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/);
    expect((await s.get('/api/orders')).status).toBe(401);
    expect((await login('paulo@teste.pt', 'Janela-Azul-Rio-52')).status).toBe(401);
    const again = await login('paulo@teste.pt', r.body.temporary_password);
    expect(again.status).toBe(200);
    expect(again.body.user.must_change_password).toBe(true);
    expect(JSON.stringify(await auditOf(A.restaurantId, 'staff.password_reset'))).not.toContain(r.body.temporary_password);
  });

  test('não se repõe a própria palavra-passe nem a de um gerente (isso é com a Altiora)', async () => {
    expect((await manager.post(`/api/staff/${A.userIds.manager}/reset-password`)).body.error.code).toBe('CANNOT_EDIT_SELF');
    const other = await manager.post('/api/staff', { name: 'Gerente Dois', email: 'gerente.dois@teste.pt', role: 'manager' });
    expect((await manager.post(`/api/staff/${other.body.member.user_id}/reset-password`)).body.error.code).toBe('MANAGER_RESET_BY_PLATFORM');
  });

  test('não se repõe a palavra-passe de uma conta que também pertence a outro restaurante (travessia entre clientes)', async () => {
    // a Altiora ligou a mesma pessoa ao restaurante B como gerente
    const shared = await manager.post('/api/staff', { name: 'Partilhada', email: 'partilhada@teste.pt', role: 'waiter' });
    const uid = shared.body.member.user_id;
    await t.db.system(async (tx) => tx`INSERT INTO restaurant_members (restaurant_id, user_id, role) VALUES (${B.restaurantId}, ${uid}, 'manager')`);
    const r = await manager.post(`/api/staff/${uid}/reset-password`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SHARED_ACCOUNT');
    // e a palavra-passe continua a funcionar
    expect((await login('partilhada@teste.pt', shared.body.temporary_password)).status).toBe(200);
  });

  test('não se repõe a de uma pessoa desativada', async () => {
    const c = await manager.post('/api/staff', { name: 'Inativo', email: 'inativo@teste.pt', role: 'kitchen' });
    await manager.patch(`/api/staff/${c.body.member.user_id}`, { active: false });
    expect((await manager.post(`/api/staff/${c.body.member.user_id}/reset-password`)).body.error.code).toBe('STAFF_INACTIVE');
  });
});

describe('isolamento entre restaurantes', () => {
  test('um gerente não vê, altera nem repõe a equipa de outro restaurante', async () => {
    const victim = B.userIds.waiter;
    expect((await manager.patch(`/api/staff/${victim}`, { active: false })).status).toBe(404);
    expect((await manager.post(`/api/staff/${victim}/reset-password`)).status).toBe(404);
    expect((await login(B.emails.waiter, PASSWORD)).status).toBe(200);
    const rows = await t.db.system(async (tx) => tx<{ active: boolean }>`SELECT active FROM restaurant_members WHERE user_id = ${victim}`);
    expect(rows[0]!.active).toBe(true);
    // e vice-versa
    expect((await managerB.patch(`/api/staff/${A.userIds.waiter}`, { active: false })).status).toBe(404);
  });

  test('um restaurante sem equipa extra continua isolado: contas criadas pelo A não aparecem no B', async () => {
    const emailsB = (await managerB.get('/api/staff')).body.members.map((m: any) => m.email);
    expect(emailsB.every((e: string) => e.startsWith('b.') || e === 'partilhada@teste.pt')).toBe(true);
    const rid = await seedRestaurant(t, 'Restaurante vazio');
    await seedUser(t, { restaurantId: rid, email: 'vazio.gerente@teste.pt', role: 'manager' });
    const c = await t.login('vazio.gerente@teste.pt');
    expect((await c.get('/api/staff')).body.members).toHaveLength(1);
  });
});
