// Restaurante-montra «Casa Aurora»: um restaurante FICTÍCIO que a página comercial mostra como demonstração
// (cardápio com fotografias e modelos 3D). Serve só de exemplo: não tem equipa, não tem mesas e não aceita pedidos.
// As imagens e os modelos são ilustrações geradas por computador (não são fotografias) e os preços são exemplos.
// Os ficheiros estão em scripts/demo-media/assets/ (DEMO_MEDIA_DIR); foram criados por scripts/demo-media/build-media.mjs.
//
// Pode ser criado de duas maneiras, sempre sem apagar nem alterar nada que já exista:
//   · ao arrancar o servidor, com SEED_SHOWCASE=true (é o que se usa no Render, onde não há linha de comandos);
//   · pela linha de comandos: bun run seed:aurora
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AllergenCode } from '../../../shared/allergens';
import type { OpeningHours } from '../../../shared/hours';
import type { Config } from '../config';
import type { Database } from '../db/client';
import { audit } from '../lib/audit';
import { inspectAsset, type ParsedAsset } from '../lib/assets';

const kz = (value: number) => Math.round(value * 100); // Kz → cêntimos

interface AuroraOption {
  name: string;
  price: number;
}
interface AuroraItem {
  /** nome base dos ficheiros em demo-media/assets (muamba → muamba.jpg, muamba-thumb.jpg e, se existir, muamba.glb) */
  media: string;
  name: string;
  description: string;
  price: number;
  ingredients: string[];
  allergens: AllergenCode[];
  sizes?: AuroraOption[];
  extras?: AuroraOption[];
}

const AURORA_HOURS: OpeningHours = {
  mon: [['12:00', '15:00'], ['19:00', '23:00']],
  tue: [['12:00', '15:00'], ['19:00', '23:00']],
  wed: [['12:00', '15:00'], ['19:00', '23:00']],
  thu: [['12:00', '15:00'], ['19:00', '23:00']],
  fri: [['12:00', '15:00'], ['19:00', '23:59']],
  sat: [['12:00', '23:59']],
  sun: [['12:00', '17:00']],
};

const AURORA_MENU: Array<{ name: string; items: AuroraItem[] }> = [
  {
    name: 'Entradas',
    items: [
      {
        media: 'pasteis', name: 'Pastéis de bacalhau', description: 'Pastéis dourados de bacalhau e batata, com limão e salsa.', price: 4500,
        ingredients: ['Bacalhau', 'Batata', 'Cebola', 'Ovos', 'Salsa', 'Farinha de trigo'], allergens: ['peixe', 'ovos', 'gluten'],
        sizes: [{ name: '3 unidades', price: 0 }, { name: '6 unidades', price: 4000 }], extras: [{ name: 'Molho picante da casa', price: 500 }],
      },
      {
        media: 'salada', name: 'Salada de manga e abacate', description: 'Folhas frescas, manga, abacate e cebola roxa, com vinagrete de limão e sésamo.', price: 3800,
        ingredients: ['Alface', 'Rúcula', 'Manga', 'Abacate', 'Cebola roxa', 'Sésamo', 'Limão', 'Azeite'], allergens: ['sesamo'],
        extras: [{ name: 'Camarão grelhado', price: 2500 }],
      },
    ],
  },
  {
    name: 'Pratos tradicionais',
    items: [
      {
        media: 'muamba', name: 'Muamba de galinha', description: 'Galinha cozinhada em molho de óleo de palma com quiabos e gindungo, servida com funge.', price: 6500,
        ingredients: ['Galinha', 'Óleo de palma', 'Quiabo', 'Cebola', 'Alho', 'Gindungo', 'Funge de mandioca'], allergens: [],
        sizes: [{ name: 'Normal', price: 0 }, { name: 'Grande', price: 1500 }], extras: [{ name: 'Funge extra', price: 500 }, { name: 'Gindungo à parte', price: 0 }],
      },
      {
        media: 'mufete', name: 'Mufete de cacusso', description: 'Cacusso grelhado com feijão de óleo de palma, banana-pão frita, mandioca cozida e cebola roxa.', price: 8500,
        ingredients: ['Cacusso', 'Feijão', 'Óleo de palma', 'Banana-pão', 'Mandioca', 'Cebola roxa', 'Limão'], allergens: ['peixe'],
        extras: [{ name: 'Banana-pão extra', price: 800 }],
      },
    ],
  },
  {
    name: 'Grelhados e mar',
    items: [
      {
        media: 'dourada', name: 'Dourada grelhada', description: 'Dourada inteira grelhada no carvão, com legumes salteados, batata cozida e limão.', price: 11500,
        ingredients: ['Dourada', 'Azeite', 'Alho', 'Limão', 'Batata', 'Courgette', 'Tomate-cereja', 'Salsa'], allergens: ['peixe'],
        extras: [{ name: 'Manteiga de alho', price: 600 }],
      },
      {
        media: 'camarao', name: 'Camarão tigre grelhado', description: 'Camarão tigre grelhado com manteiga de alho e ervas finas.', price: 14500,
        ingredients: ['Camarão tigre', 'Manteiga', 'Alho', 'Salsa', 'Limão'], allergens: ['crustaceos', 'leite'],
        sizes: [{ name: '4 unidades', price: 0 }, { name: '6 unidades', price: 5000 }], extras: [{ name: 'Arroz de manteiga', price: 1200 }],
      },
      {
        media: 'costeleta', name: 'Costeleta de vaca', description: 'Costeleta de vaca grelhada, com batata frita, manteiga de ervas e molho da casa.', price: 13500,
        ingredients: ['Vaca', 'Manteiga de ervas', 'Batata', 'Alecrim', 'Sal grosso'], allergens: ['leite'],
        extras: [{ name: 'Ovo estrelado', price: 500 }, { name: 'Batata frita extra', price: 1200 }],
      },
    ],
  },
  {
    name: 'Sobremesas',
    items: [
      { media: 'pudim', name: 'Pudim de leite', description: 'Receita da casa, com calda de caramelo e hortelã.', price: 3200, ingredients: ['Leite', 'Ovos', 'Açúcar', 'Caramelo', 'Hortelã'], allergens: ['leite', 'ovos'] },
      { media: 'mousse', name: 'Mousse de maracujá', description: 'Mousse cremosa de maracujá, com sementes e hortelã.', price: 3000, ingredients: ['Maracujá', 'Natas', 'Ovos', 'Açúcar', 'Hortelã'], allergens: ['leite', 'ovos'] },
      { media: 'cocada', name: 'Cocada amarela', description: 'Doce tradicional de coco e gemas.', price: 2800, ingredients: ['Coco', 'Gemas', 'Açúcar'], allergens: ['ovos'] },
    ],
  },
  {
    name: 'Bebidas',
    items: [
      {
        media: 'sumo', name: 'Sumo de manga natural', description: 'Feito na hora com manga fresca.', price: 2200, ingredients: ['Manga', 'Água', 'Açúcar'], allergens: [],
        sizes: [{ name: 'Copo', price: 0 }, { name: 'Jarro', price: 3000 }], extras: [{ name: 'Sem açúcar', price: 0 }, { name: 'Sem gelo', price: 0 }],
      },
      { media: 'cafe', name: 'Café expresso', description: 'Café de torra média, servido bem quente.', price: 1000, ingredients: ['Café'], allergens: [] },
    ],
  },
];

interface MediaManifest {
  dishes: Record<string, { image: string; thumb: string; model: string | null }>;
}

async function readAsset(dir: string, name: string): Promise<{ bytes: Uint8Array; info: ParsedAsset; sha256: string }> {
  const bytes = new Uint8Array(await readFile(join(dir, name)));
  const info = inspectAsset(bytes); // a mesma verificação que se faz aos ficheiros enviados pelos restaurantes
  return { bytes, info, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export type ShowcaseResult = { created: false; slug: string } | { created: true; slug: string; dishes: number; models: number };

/**
 * Cria a «Casa Aurora» com o endereço de DEMO_RESTAURANT_SLUG, se ainda não existir nenhum restaurante com esse endereço.
 * Lê e verifica todos os ficheiros antes de tocar na base de dados e grava tudo numa única transação: ou fica completo, ou não fica nada.
 */
export async function seedShowcase(db: Database, config: Pick<Config, 'demoSlug' | 'demoMediaDir'>): Promise<ShowcaseResult> {
  const slug = config.demoSlug;
  const dir = config.demoMediaDir;
  const existing = await db.system(async (tx) => (await tx<{ id: string }>`SELECT id FROM restaurants WHERE slug = ${slug}`)[0]);
  if (existing) return { created: false, slug };

  // lê e verifica todos os ficheiros antes de tocar na base de dados
  let manifest: MediaManifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as MediaManifest;
  } catch {
    throw new Error(`Não encontrei as imagens e os modelos 3D de demonstração em «${dir}» (DEMO_MEDIA_DIR).`);
  }
  const media = new Map<string, Awaited<ReturnType<typeof readAsset>>>();
  const wanted = ['logo.png', 'cover.jpg'];
  for (const cat of AURORA_MENU) {
    for (const item of cat.items) {
      const m = manifest.dishes[item.media];
      if (!m) throw new Error(`Falta «${item.media}» em ${join(dir, 'manifest.json')}`);
      wanted.push(m.image, m.thumb);
      if (m.model) wanted.push(m.model);
    }
  }
  for (const name of wanted) media.set(name, await readAsset(dir, name));

  const description = 'Cozinha de autor com sabores de Angola e do Atlântico. Restaurante fictício, criado para demonstrar o ALTIORA MENU.';
  const dishes = await db.system(async (tx) => {
    const [r] = await tx<{ id: string }>`
      INSERT INTO restaurants (name, slug, description, accent_color, address, email, timezone, opening_hours, theme, font, is_demo, service_fee_bps)
      VALUES ('Casa Aurora', ${slug}, ${description}, '#C9A24B', 'Rua das Acácias, 12, Talatona, Luanda (endereço fictício)', 'reservas@casaaurora.example',
              'Africa/Luanda', ${AURORA_HOURS}::jsonb, 'dark', 'serif', true, 0)
      RETURNING id`;
    const rid = r!.id;
    await tx`INSERT INTO subscriptions (restaurant_id, plan_code, notes) VALUES (${rid}, 'premium', 'Restaurante de demonstração da página comercial')`;

    const store = async (name: string): Promise<string> => {
      const a = media.get(name)!;
      const [row] = await tx<{ id: string }>`
        INSERT INTO assets (restaurant_id, kind, content_type, byte_size, sha256, width, height, data)
        VALUES (${rid}, ${a.info.kind}, ${a.info.contentType}, ${a.bytes.byteLength}, ${a.sha256}, ${a.info.width}, ${a.info.height}, ${a.bytes})
        RETURNING id`;
      return `/a/${row!.id}`;
    };
    await tx`UPDATE restaurants SET logo_url = ${await store('logo.png')}, cover_url = ${await store('cover.jpg')} WHERE id = ${rid}`;

    let count = 0;
    let categoryOrder = 0;
    for (const cat of AURORA_MENU) {
      const [c] = await tx<{ id: string }>`INSERT INTO categories (restaurant_id, name, display_order) VALUES (${rid}, ${cat.name}, ${categoryOrder++}) RETURNING id`;
      let itemOrder = 0;
      for (const item of cat.items) {
        const m = manifest.dishes[item.media]!;
        const image = await store(m.image);
        const thumb = await store(m.thumb);
        const model = m.model ? await store(m.model) : null;
        const [it] = await tx<{ id: string }>`
          INSERT INTO menu_items (restaurant_id, category_id, name, description, image_url, thumb_url, model_url, ingredients, allergens, price_cents, available, display_order)
          VALUES (${rid}, ${c!.id}, ${item.name}, ${item.description}, ${image}, ${thumb}, ${model}, ${item.ingredients}::text[], ${item.allergens}::text[], ${kz(item.price)}, true, ${itemOrder++})
          RETURNING id`;
        let optionOrder = 0;
        for (const [kind, list] of [['size', item.sizes ?? []], ['extra', item.extras ?? []]] as const) {
          for (const o of list) {
            await tx`
              INSERT INTO menu_item_options (restaurant_id, menu_item_id, name, price_delta_cents, kind, display_order)
              VALUES (${rid}, ${it!.id}, ${o.name}, ${kz(o.price)}, ${kind}, ${optionOrder++})`;
          }
        }
        count++;
      }
    }
    await audit(tx, { restaurantId: rid, actorId: null, actorRole: 'platform', action: 'platform.seed_demo', entityType: 'restaurant', entityId: rid, metadata: { restaurant: 'Casa Aurora' } });
    return count;
  });

  const models = Object.values(manifest.dishes).filter((d) => d.model).length;
  return { created: true, slug, dishes, models };
}
