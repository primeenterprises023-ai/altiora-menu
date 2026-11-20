// Dados de demonstração.
//   bun run seed:demo     → cria DOIS restaurantes (só se ainda não existirem):
//                           · Terraza Talatona: restaurante completo (menu em Kz, mesas e equipa) para experimentar o sistema;
//                             as palavras-passe são geradas ao acaso e mostradas UMA vez (ou DEMO_PASSWORD="...").
//                           · Casa Aurora: restaurante fictício que serve de montra na página comercial (imagens e modelos 3D de
//                             demonstração geradas por computador; sem equipa e sem pedidos). O endereço vem de DEMO_RESTAURANT_SLUG.
//   bun run seed:aurora   → cria só a Casa Aurora (é o que se usa em produção: não cria contas de equipa nem palavras-passe).
import { fileURLToPath } from 'node:url';
import { checkPasswordStrength, hashPassword } from '../server/src/auth/password';
import { ConfigError, loadConfig, type Config } from '../server/src/config';
import { Database } from '../server/src/db/client';
import { runMigrations } from '../server/src/db/migrate';
import { audit } from '../server/src/lib/audit';
import { seedShowcase } from '../server/src/demo/showcase';
import { randomToken, temporaryPassword } from '../server/src/lib/crypto';

const SLUG = 'terraza-talatona';
const kz = (value: number) => Math.round(value * 100); // Kz → cêntimos

interface DemoOption {
  name: string;
  price: number;
}
interface DemoItem {
  name: string;
  description: string;
  price: number;
  available?: boolean;
  options?: DemoOption[];
}
interface DemoCategory {
  name: string;
  items: DemoItem[];
}

const MENU: DemoCategory[] = [
  {
    name: 'Entradas',
    items: [
      { name: 'Pastéis de bacalhau', description: 'Seis unidades, crocantes por fora e macios por dentro.', price: 4500 },
      { name: 'Camarão ao alho', description: 'Camarão salteado em alho e azeite, com pão da casa.', price: 9500 },
      { name: 'Mandioca frita', description: 'Com molho de gindungo.', price: 3000 },
      { name: 'Salada de tomate e cebola', description: 'Tomate, cebola roxa, azeite e orégãos.', price: 2500 },
    ],
  },
  {
    name: 'Pratos tradicionais',
    items: [
      {
        name: 'Muamba de galinha',
        description: 'Galinha estufada em azeite de palma, com quiabos e gindungo. Acompanha funge.',
        price: 8500,
        options: [
          { name: 'Funge extra', price: 1000 },
          { name: 'Feijão de óleo de palma', price: 1500 },
        ],
      },
      { name: 'Calulu de peixe seco', description: 'Peixe seco e fumado com folhas, quiabos e azeite de palma. Acompanha arroz e funge.', price: 9800 },
      { name: 'Mufete de cacusso', description: 'Peixe grelhado com feijão de óleo de palma, banana-pão, mandioca cozida e cebola.', price: 12500 },
      { name: 'Feijoada à angolana', description: 'Feijão com carne de porco e chouriço, servida com arroz branco.', price: 9000 },
    ],
  },
  {
    name: 'Carnes',
    items: [
      {
        name: 'Costeleta de vaca grelhada',
        description: 'Grelhada no carvão, com batata frita e salada.',
        price: 13500,
        options: [
          { name: 'Ovo estrelado', price: 500 },
          { name: 'Batata frita extra', price: 1500 },
          { name: 'Molho de gindungo', price: 300 },
        ],
      },
      { name: 'Frango no churrasco', description: 'Meio frango marinado em limão e gindungo, com arroz e salada.', price: 9500 },
    ],
  },
  {
    name: 'Peixe e marisco',
    items: [
      { name: 'Dourada grelhada', description: 'Dourada inteira grelhada, com legumes salteados e batata cozida.', price: 14000 },
      { name: 'Arroz de marisco', description: 'Arroz malandrinho com camarão, mexilhão e amêijoa.', price: 15500 },
      { name: 'Lagosta grelhada', description: 'Lagosta de Luanda grelhada com manteiga de alho.', price: 28000, available: false },
    ],
  },
  {
    name: 'Sobremesas',
    items: [
      { name: 'Pudim de leite', description: 'Receita da casa, com calda de caramelo.', price: 3000 },
      { name: 'Mousse de maracujá', description: 'Maracujá fresco e natas.', price: 3200 },
      { name: 'Cocada amarela', description: 'Doce de coco e gemas, receita tradicional.', price: 2800 },
    ],
  },
  {
    name: 'Bebidas',
    items: [
      { name: 'Água mineral 0,5 l', description: 'Sem gás.', price: 800 },
      {
        name: 'Sumo de maracujá',
        description: 'Natural, feito na hora.',
        price: 2000,
        options: [
          { name: 'Sem açúcar', price: 0 },
          { name: 'Sem gelo', price: 0 },
        ],
      },
      { name: 'Sumo de manga', description: 'Natural, feito na hora.', price: 2000 },
      { name: 'Cerveja Cuca', description: 'Garrafa 33 cl, bem gelada.', price: 1800 },
      { name: 'Cerveja Nocal', description: 'Garrafa 33 cl, bem gelada.', price: 1800 },
      { name: 'Refrigerante', description: 'Lata 33 cl.', price: 1500 },
      { name: 'Café expresso', description: '', price: 1000 },
    ],
  },
];

const TABLES: Array<{ number: number; label: string | null }> = [
  { number: 1, label: 'Esplanada' },
  { number: 2, label: 'Esplanada' },
  { number: 3, label: 'Esplanada' },
  { number: 4, label: 'Salão' },
  { number: 5, label: 'Salão' },
  { number: 6, label: 'Salão' },
  { number: 7, label: 'Varanda' },
  { number: 8, label: 'Varanda' },
];



// ---------------------------------------------------------------------------------------------------------------------
// Casa Aurora: restaurante FICTÍCIO da página comercial. Os dados e a criação estão em server/src/demo/showcase.ts
// (o servidor também os usa ao arrancar, com SEED_SHOWCASE=true).
// ---------------------------------------------------------------------------------------------------------------------
const MEDIA_DIR = fileURLToPath(new URL('./demo-media/assets/', import.meta.url));

async function seedAurora(db: Database, config: Config): Promise<boolean> {
  const result = await seedShowcase(db, { demoSlug: config.demoSlug, demoMediaDir: MEDIA_DIR });
  if (!result.created) {
    console.log(`Já existe um restaurante com o endereço «${result.slug}»; o restaurante de demonstração da página comercial não foi criado de novo.`);
    return false;
  }
  console.log(`\nRestaurante de demonstração da página comercial criado: Casa Aurora (${result.dishes} pratos, ${result.models} deles com modelo 3D).`);
  console.log(`  Cardápio:  ${config.publicBaseUrl}/r/${result.slug}`);
  console.log(`  Página comercial: ${config.publicBaseUrl}/ (mostra este restaurante; o endereço vem de DEMO_RESTAURANT_SLUG, agora «${result.slug}»)`);
  console.log('  As imagens e os modelos 3D são ilustrações geradas por computador e os preços são exemplos.');
  console.log('  Este restaurante não tem equipa nem aceita pedidos: serve só de montra.\n');
  return true;
}


async function seedTerraza(db: Database, config: Config): Promise<void> {
  const existing = await db.system(async (tx) => (await tx<{ id: string }>`SELECT id FROM restaurants WHERE slug = ${SLUG}`)[0]);
  if (existing) {
    console.log(`O restaurante de demonstração (Terraza Talatona) já existe. Para o ver: ${config.publicBaseUrl}/entrar`);
    console.log('(Para recomeçar do zero, apague a base de dados e execute de novo.)');
    return;
  }

  const password = process.env.DEMO_PASSWORD?.trim() || `${temporaryPassword()}-${randomToken(3)}`;
  const weak = checkPasswordStrength(password);
  if (weak) throw new Error(`DEMO_PASSWORD recusada: ${weak}`);
  const passwordHash = await hashPassword(password, config.scryptLogN);

  const result = await db.system(async (tx) => {
    const [restaurant] = await tx<{ id: string }>`
      INSERT INTO restaurants (name, slug, description, accent_color, address, timezone, service_fee_bps)
      VALUES ('Terraza Talatona', ${SLUG}, 'Terra e mar, à mesa. Cozinha angolana e grelhados no carvão.', '#0E6F7E', 'Talatona, Luanda', 'Africa/Luanda', 1000)
      RETURNING id`;
    const rid = restaurant!.id;
    await tx`INSERT INTO subscriptions (restaurant_id, plan_code, notes) VALUES (${rid}, 'premium', 'Restaurante de demonstração')`;

    const people = [
      { email: 'gerente@terraza.demo', name: 'Maria Gerente', role: 'manager' },
      { email: 'cozinha@terraza.demo', name: 'Cozinha', role: 'kitchen' },
      { email: 'empregado@terraza.demo', name: 'Paulo Empregado', role: 'waiter' },
    ] as const;
    for (const p of people) {
      const [u] = await tx<{ id: string }>`
        INSERT INTO users (email, name, password_hash, must_change_password) VALUES (${p.email}, ${p.name}, ${passwordHash}, false) RETURNING id`;
      await tx`INSERT INTO restaurant_members (restaurant_id, user_id, role) VALUES (${rid}, ${u!.id}, ${p.role})`;
    }

    // administrador da plataforma (só se ainda não existir nenhum)
    let adminCreated = false;
    const [hasAdmin] = await tx<{ n: number }>`SELECT count(*)::int AS n FROM users WHERE is_platform_admin`;
    if (hasAdmin!.n === 0) {
      await tx`
        INSERT INTO users (email, name, password_hash, is_platform_admin, must_change_password)
        VALUES ('admin@altiora.demo', 'Administrador Altiora', ${passwordHash}, true, false)`;
      adminCreated = true;
    }

    let categoryOrder = 0;
    for (const cat of MENU) {
      const [c] = await tx<{ id: string }>`
        INSERT INTO categories (restaurant_id, name, display_order) VALUES (${rid}, ${cat.name}, ${categoryOrder++}) RETURNING id`;
      let itemOrder = 0;
      for (const item of cat.items) {
        const [m] = await tx<{ id: string }>`
          INSERT INTO menu_items (restaurant_id, category_id, name, description, price_cents, available, display_order)
          VALUES (${rid}, ${c!.id}, ${item.name}, ${item.description || null}, ${kz(item.price)}, ${item.available ?? true}, ${itemOrder++}) RETURNING id`;
        let optionOrder = 0;
        for (const o of item.options ?? []) {
          await tx`
            INSERT INTO menu_item_options (restaurant_id, menu_item_id, name, price_delta_cents, display_order)
            VALUES (${rid}, ${m!.id}, ${o.name}, ${kz(o.price)}, ${optionOrder++})`;
        }
      }
    }

    const tables: Array<{ number: number; label: string | null; token: string }> = [];
    for (const t of TABLES) {
      const token = randomToken(16);
      await tx`
        INSERT INTO restaurant_tables (restaurant_id, table_number, label, qr_token) VALUES (${rid}, ${t.number}, ${t.label}, ${token})`;
      tables.push({ ...t, token });
    }
    await audit(tx, { restaurantId: rid, actorId: null, actorRole: 'platform', action: 'platform.seed_demo', entityType: 'restaurant', entityId: rid });
    return { tables, adminCreated };
  });

  const base = config.publicBaseUrl;
  console.log('\nRestaurante de demonstração criado: Terraza Talatona\n');
  console.log('Contas (a mesma palavra-passe para todas; guarde-a, não volta a ser mostrada):');
  console.log(`  Palavra-passe: ${password}`);
  console.log('  gerente@terraza.demo     gerente');
  console.log('  cozinha@terraza.demo     cozinha');
  console.log('  empregado@terraza.demo   empregado de mesa');
  if (result.adminCreated) console.log('  admin@altiora.demo       administrador da plataforma Altiora');
  console.log(`\nEntrar (equipa): ${base}/entrar`);
  console.log('\nMenus por QR Code (um endereço por mesa):');
  for (const t of result.tables) console.log(`  Mesa ${t.number}${t.label ? ` (${t.label})` : ''}: ${base}/menu/${t.token}`);
  console.log('\nO gerente pode imprimir os QR Codes no separador "Mesas e QR Codes".\n');
}

async function main() {
  const config = loadConfig();
  const onlyAurora = process.argv[2] === 'aurora';
  const db = new Database(config.databaseUrl, { max: 2, ssl: config.databaseSsl, prepare: config.databasePrepare });
  try {
    await runMigrations(db.sql, config.migrationsDir);
    if (!onlyAurora) await seedTerraza(db, config);
    await seedAurora(db, config);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error('Falha ao criar os dados de demonstração:', (err as Error).message);
  process.exit(1);
});
