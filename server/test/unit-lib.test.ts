// Peças de apoio testadas isoladamente: palavras-passe, tokens, semáforo, endereços (slug), registos e mensagens de validação.
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { checkPasswordStrength, hashPassword, verifyPassword } from '../src/auth/password';
import { randomToken, safeEqual, sha256Hex, temporaryPassword } from '../src/lib/crypto';
import { createLogger, scrub } from '../src/lib/log';
import { Semaphore } from '../src/lib/semaphore';
import { slugify } from '../src/lib/slug';
import { installZodPt, zodDetails } from '../src/lib/zod-pt';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('palavras-passe', () => {
  test('o hash tem sal próprio, parâmetros incluídos e nunca contém a palavra-passe', async () => {
    const h1 = await hashPassword('Uma-Senha-Forte-1', 10);
    const h2 = await hashPassword('Uma-Senha-Forte-1', 10);
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^scrypt\$10\$8\$1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
    expect(h1).not.toContain('Forte');
  });

  test('verifica palavras-passe certas e erradas; parâmetros guardados permitem mudar o custo no futuro', async () => {
    const h = await hashPassword('Uma-Senha-Forte-1', 10);
    expect(await verifyPassword('Uma-Senha-Forte-1', h)).toBe(true);
    for (const wrong of ['uma-senha-forte-1', 'Uma-Senha-Forte-1 ', 'Uma-Senha-Forte-2', '', 'x']) expect({ wrong, ok: await verifyPassword(wrong, h) }).toEqual({ wrong, ok: false });
    const stronger = await hashPassword('Outra-Senha-2026', 12);
    expect(stronger.startsWith('scrypt$12$')).toBe(true);
    expect(await verifyPassword('Outra-Senha-2026', stronger)).toBe(true);
    expect(await verifyPassword('Uma-Senha-Forte-1', stronger)).toBe(false);
  });

  test('letras equivalentes em Unicode (ex.: ligadura "ﬁ") contam como iguais; acentos diferentes não', async () => {
    const h = await hashPassword('ﬁnal-Senha-2026', 10);
    expect(await verifyPassword('final-Senha-2026', h)).toBe(true);
    const accent = await hashPassword('Açúcar-Forte-2026', 10);
    expect(await verifyPassword('Acucar-Forte-2026', accent)).toBe(false);
    expect(await verifyPassword('Açúcar-Forte-2026', accent)).toBe(true);
  });

  test('um hash guardado mal formado ou com custo absurdo é recusado depressa, sem rebentar nem gastar memória', async () => {
    const good = await hashPassword('Uma-Senha-Forte-1', 10);
    const [, , , , salt, key] = good.split('$');
    const bad = [
      '', 'x', 'scrypt', 'scrypt$10$8$1$a', `scrypt$10$8$1$${salt}$${key}$extra`, `bcrypt$10$8$1$${salt}$${key}`,
      `scrypt$9$8$1$${salt}$${key}`, `scrypt$21$8$1$${salt}$${key}`, `scrypt$30$8$1$${salt}$${key}`, `scrypt$10$0$1$${salt}$${key}`, `scrypt$10$17$1$${salt}$${key}`,
      `scrypt$10$8$0$${salt}$${key}`, `scrypt$10$8$5$${salt}$${key}`, `scrypt$x$8$1$${salt}$${key}`, `scrypt$10.5$8$1$${salt}$${key}`, `scrypt$10$8$1$$`, `scrypt$10$8$1$${salt}$`,
    ];
    const started = Date.now();
    for (const stored of bad) expect({ stored: stored.slice(0, 30), ok: await verifyPassword('Uma-Senha-Forte-1', stored) }).toEqual({ stored: stored.slice(0, 30), ok: false });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('muitos cálculos em simultâneo terminam todos (limite de memória respeitado)', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => hashPassword(`Senha-Numero-${i}-xyz`, 12)));
    expect(new Set(results).size).toBe(12);
    const checks = await Promise.all(results.map((h, i) => verifyPassword(`Senha-Numero-${i}-xyz`, h)));
    expect(checks.every(Boolean)).toBe(true);
  });

  test('regras de qualidade: tamanho, repetição, palavras comuns e partes do e-mail', () => {
    expect(checkPasswordStrength('curta1')).toContain('10 caracteres');
    expect(checkPasswordStrength('x'.repeat(129) + 'abc')).toContain('128');
    expect(checkPasswordStrength('aaaaaaaaaaaa')).toContain('repetitiva');
    expect(checkPasswordStrength('abababababab')).toContain('repetitiva');
    for (const common of ['password123', 'PASSWORD123', 'Altiora2026', '1234567890', 'restaurante1', 'Senha12345']) {
      expect({ common, msg: checkPasswordStrength(common) }).toEqual({ common, msg: 'Esta palavra-passe é demasiado comum. Escolha outra.' });
    }
    expect(checkPasswordStrength('maria-garcia-2026', 'maria.garcia@terraza.ao')).toBeNull(); // "maria.garcia" não aparece como tal
    expect(checkPasswordStrength('a-maria123-x9!', 'maria@terraza.ao')).toContain('e-mail');
    expect(checkPasswordStrength('maria@terraza.ao', 'maria@terraza.ao')).toContain('e-mail');
    expect(checkPasswordStrength('Cavalo-Bateria-Agrafo-7')).toBeNull();
    expect(checkPasswordStrength('Uma-Senha-Forte-1', 'ana@x.pt')).toBeNull(); // partes curtas do e-mail (< 4) não contam
  });
});

describe('tokens e comparações', () => {
  test('tokens aleatórios: tamanho, alfabeto seguro para endereços e sem repetições', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const t = randomToken(16);
      expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
      seen.add(t);
    }
    expect(seen.size).toBe(2000);
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]{43}$/); // tamanho do token de sessão
    expect(randomToken()).toHaveLength(22);
  });

  test('sha256 e comparação em tempo constante', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('ação', 'ação')).toBe(true);
    expect(safeEqual('ação', 'acao')).toBe(false);
  });

  test('palavra-passe temporária: formato legível, sem caracteres ambíguos e distribuição uniforme', () => {
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const counts = new Map<string, number>([...alphabet].map((c) => [c, 0]));
    const seen = new Set<string>();
    const N = 20_000;
    for (let i = 0; i < N; i++) {
      const p = temporaryPassword();
      expect(p).toMatch(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/);
      seen.add(p);
      for (const ch of p.replace(/-/g, '')) {
        expect(counts.has(ch)).toBe(true); // nunca "0", "1", "l", "I", "O", "o", "i"
        counts.set(ch, counts.get(ch)! + 1);
      }
    }
    expect(seen.size).toBe(N);
    // teste do qui-quadrado: todos os caracteres igualmente prováveis (53 graus de liberdade; 120 é um limite muito folgado)
    const expected = (N * 14) / alphabet.length;
    let chi2 = 0;
    for (const c of counts.values()) chi2 += (c - expected) ** 2 / expected;
    expect(chi2).toBeLessThan(120);
  });
});

describe('Semaphore', () => {
  test('nunca corre mais tarefas ao mesmo tempo do que o limite e todas terminam por ordem de chegada', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (i: number) =>
      sem.run(async () => {
        order.push(i);
        active++;
        peak = Math.max(peak, active);
        await sleep(15);
        active--;
        return i * 2;
      });
    const results = await Promise.all(Array.from({ length: 7 }, (_, i) => task(i)));
    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(sem.waiting).toBe(0);
  });

  test('uma tarefa que falha devolve o erro e liberta a vaga', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => Promise.reject(new Error('falhou')))).rejects.toThrow('falhou');
    expect(await sem.run(async () => 'seguinte')).toBe('seguinte');
    const a = sem.run(async () => {
      await sleep(10);
      throw new Error('a');
    });
    const b = sem.run(async () => 'b');
    await expect(a).rejects.toThrow('a');
    expect(await b).toBe('b');
  });
});

describe('slugify', () => {
  test('transforma nomes em endereços simples (sem acentos nem símbolos)', () => {
    const cases: Array<[string, string]> = [
      ['Terraço do Mar & Sol', 'terraco-do-mar-sol'],
      ['Café   Central!!', 'cafe-central'],
      ['Água Pé', 'agua-pe'],
      ['  --Cantinho 2026--  ', 'cantinho-2026'],
      ['Restaurante A', 'restaurante-a'],
      ['A', 'restaurante'],
      ['!!!', 'restaurante'],
      ['寿司', 'restaurante'],
      ['', 'restaurante'],
    ];
    for (const [input, out] of cases) expect({ input, out: slugify(input) }).toEqual({ input, out });
  });

  test('limita o tamanho e o resultado é sempre válido como endereço', () => {
    const long = slugify('palavra '.repeat(30));
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long.endsWith('-')).toBe(false);
    let seed = 7;
    const pool = 'abcXYZ áéíóúçãõ 0123456789 -_!?@#$%&*()[]{}<>/\\\'"`~^+=|;:,.\u0000\n\t😀ñ';
    for (let i = 0; i < 500; i++) {
      let s = '';
      const len = 1 + (seed % 60);
      for (let j = 0; j < len; j++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        s += pool[seed % pool.length];
      }
      expect({ s, ok: /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slugify(s)) }).toEqual({ s, ok: true });
    }
  });
});

describe('registos: scrub e filtragem', () => {
  test('scrub remove credenciais de endereços e pares chave=valor', () => {
    const cases: Array<[string, string]> = [
      ['postgres://u:p@h/db', 'postgres://***@h/db'],
      ['postgresql://user:p@ss@host:5432/db?sslmode=require', 'postgresql://***@host:5432/db?sslmode=require'],
      ['falha em https://user@example.com/x e postgres://a:b@c/d', 'falha em https://***@example.com/x e postgres://***@c/d'],
      ['https://example.com/a@b', 'https://example.com/a@b'],
      ['sem credenciais: https://example.com/caminho?x=1', 'sem credenciais: https://example.com/caminho?x=1'],
      ['password=abc123 resto', 'password=*** resto'],
      ['Password=ABC&token=xyz&a=1', 'Password=***&token=***&a=1'],
      ['secret=a,b', 'secret=***,b'],
      ['nada a esconder', 'nada a esconder'],
    ];
    for (const [input, out] of cases) expect({ input, out: scrub(input) }).toEqual({ input, out });
  });

  const capture = (level: 'debug' | 'info' | 'warn' | 'error' = 'info') => {
    const lines: string[] = [];
    return { lines, log: createLogger(level, (l) => lines.push(l)), parsed: () => lines.map((l) => JSON.parse(l)) };
  };

  test('respeita o nível e escreve uma linha JSON por evento', () => {
    const { log, lines, parsed } = capture('warn');
    log.debug('d');
    log.info('i');
    log.warn('w', { n: 1 });
    log.error('e');
    expect(lines).toHaveLength(2);
    expect(parsed().map((e) => [e.level, e.msg])).toEqual([['warn', 'w'], ['error', 'e']]);
    expect(parsed()[0]).toMatchObject({ n: 1 });
    expect(typeof parsed()[0].ts).toBe('string');
    expect(lines.every((l) => !l.includes('\n'))).toBe(true);
  });

  test('campos sensíveis nunca são escritos, mesmo dentro de objetos e listas', () => {
    const { log, parsed } = capture();
    log.info('teste', {
      ok: 'visível',
      password: 'p1', new_password: 'p2', token: 't', csrf_token: 't2', secret: 's', cookie: 'c', Authorization: 'Bearer x', public_code: 'abc', qr_url: 'u',
      database_url: 'postgres://u:p@h/d', session_id: 'sid1', sid: 'sid2', altiora_sid: 'sid3', 'x-sid': 'sid4',
      nested: { password: 'p3', fine: 1, deeper: { token: 'x', a: [{ cookie: 'c2', b: 2 }] } },
      lista: [{ secret: 's2', v: 1 }],
    });
    const e = parsed()[0];
    const text = JSON.stringify(e);
    for (const leaked of ['p1', 'p2', '"t"', 't2', '"s"', '"c"', 'Bearer', 'abc', 'postgres://', 'sid1', 'sid2', 'sid3', 'sid4', 'p3', 's2', 'c2']) {
      expect({ leaked, found: text.includes(leaked) }).toEqual({ leaked, found: false });
    }
    expect(e.ok).toBe('visível');
    expect(e.nested.fine).toBe(1);
    expect(e.password).toBe('[omitido]');
    expect(e.lista[0].v).toBe(1);
  });

  test('estruturas muito fundas, circulares, bigint e datas não rebentam nem deixam passar segredos', () => {
    const { log, parsed, lines } = capture();
    const circular: Record<string, unknown> = { nome: 'ciclo' };
    circular.self = circular;
    log.info('teste', {
      fundo: { a: { b: { c: { password: 'SEGREDO-FUNDO' } } } },
      circular,
      grande: 12345678901234567890n,
      quando: new Date('2026-10-28T10:00:00Z'),
      invalida: new Date('lixo'),
      funcao: () => 1,
      get perigoso(): string {
        throw new Error('getter');
      },
    });
    expect(lines).toHaveLength(0); // o getter que falha impede esta linha, mas não rebenta o servidor
    log.info('teste', { fundo: { a: { b: { c: { password: 'SEGREDO-FUNDO' } } } }, circular, grande: 12345678901234567890n, quando: new Date('2026-10-28T10:00:00Z'), invalida: new Date('lixo'), funcao: () => 1 });
    const e = parsed()[0];
    expect(JSON.stringify(e)).not.toContain('SEGREDO-FUNDO');
    expect(e.fundo.a.b).toBe('[…]');
    expect(e.circular.nome).toBe('ciclo');
    expect(e.grande).toBe('12345678901234567890');
    expect(e.quando).toBe('2026-10-28T10:00:00.000Z');
    expect(e.invalida).toBeNull();
    expect('funcao' in e).toBe(false);
  });

  test('chaves parecidas mas inofensivas não são escondidas ("inside", "side", "residential")', () => {
    const { log, parsed } = capture();
    log.info('teste', { inside: 1, side: 2, residential: 3, route: 'GET /x' });
    expect(parsed()[0]).toMatchObject({ inside: 1, side: 2, residential: 3, route: 'GET /x' });
  });

  test('erros mostram só nome, mensagem (sem credenciais) e códigos da base de dados; nunca o rasto interno', () => {
    const { log, parsed } = capture();
    const err = Object.assign(new Error('ligação a postgres://admin:Segredo@db:5432/x falhou ' + 'y'.repeat(500)), { errno: '23505', constraint: 'categories_name_uq', query: 'SELECT 1', stack: 'STACK-SECRETO' });
    log.error('erro', { err });
    const e = parsed()[0];
    expect(e.err.name).toBe('Error');
    expect(e.err.sqlstate).toBe('23505');
    expect(e.err.constraint).toBe('categories_name_uq');
    expect(e.err.message.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(e)).not.toMatch(/Segredo|STACK-SECRETO|SELECT 1/);
    expect(e.err.message).toContain('postgres://***@db:5432');
  });

  test('textos muito longos e listas grandes são cortados; a mensagem também é limpa de credenciais', () => {
    const { log, parsed } = capture();
    log.info('ligar a postgres://u:SENHA@h/d', { longo: 'a'.repeat(900), lista: Array.from({ length: 50 }, (_, i) => i), url: 'https://x.pt/?password=SENHA2' });
    const e = parsed()[0];
    expect(e.msg).toBe('ligar a postgres://***@h/d');
    expect(e.longo.length).toBe(501);
    expect(e.longo.endsWith('…')).toBe(true);
    expect(e.lista).toHaveLength(20);
    expect(e.url).toBe('https://x.pt/?password=***');
  });
});

describe('mensagens de validação em português', () => {
  installZodPt();
  const msg = (schema: z.ZodTypeAny, value: unknown) => zodDetails(schema.safeParse(value).error!).map((d) => `${d.field}: ${d.message}`);

  test('as mensagens mais comuns', () => {
    expect(msg(z.object({ a: z.string() }), {})).toEqual(['a: Campo obrigatório.']);
    expect(msg(z.object({ a: z.string() }), { a: null })).toEqual(['a: Campo obrigatório.']);
    expect(msg(z.object({ a: z.string() }), { a: 5 })).toEqual(['a: Valor inválido: era esperado texto.']);
    expect(msg(z.object({ a: z.number() }), { a: 'x' })).toEqual(['a: Valor inválido: era esperado número.']);
    expect(msg(z.number().int(), 1.5)).toEqual(['(corpo): Valor inválido: era esperado número inteiro.']);
    expect(msg(z.string().min(3), 'ab')).toEqual(['(corpo): Tem de ter pelo menos 3 caracteres.']);
    expect(msg(z.string().min(1), '')).toEqual(['(corpo): Campo obrigatório.']);
    expect(msg(z.string().max(2), 'abc')).toEqual(['(corpo): Pode ter no máximo 2 caracteres.']);
    expect(msg(z.number().min(5), 1)).toEqual(['(corpo): O valor mínimo é 5.']);
    expect(msg(z.number().max(5), 9)).toEqual(['(corpo): O valor máximo é 5.']);
    expect(msg(z.array(z.string()).min(1), [])).toEqual(['(corpo): Indique pelo menos 1 elemento(s).']);
    expect(msg(z.array(z.string()).max(1), ['a', 'b'])).toEqual(['(corpo): Indique no máximo 1 elemento(s).']);
    expect(msg(z.string().email(), 'x')).toEqual(['(corpo): E-mail inválido.']);
    expect(msg(z.string().uuid(), 'x')).toEqual(['(corpo): Identificador inválido.']);
    expect(msg(z.string().url(), 'x')).toEqual(['(corpo): Endereço inválido.']);
    expect(msg(z.string().regex(/^a$/), 'b')).toEqual(['(corpo): Formato inválido.']);
    expect(msg(z.enum(['a', 'b']), 'c')).toEqual(['(corpo): Valor inválido. Opções: a, b.']);
    expect(msg(z.object({ a: z.string() }).strict(), { a: 'x', extra: 1 })).toEqual(['(corpo): Campos não permitidos: extra.']);
  });

  test('o caminho dos campos aninhados é legível e a lista é limitada a 20 erros', () => {
    expect(msg(z.object({ items: z.array(z.object({ q: z.number() })) }), { items: [{ q: 'x' }] })).toEqual(['items.0.q: Valor inválido: era esperado número.']);
    const many = z.array(z.number()).safeParse(Array.from({ length: 50 }, () => 'x'));
    expect(zodDetails(many.error!)).toHaveLength(20);
  });
});
