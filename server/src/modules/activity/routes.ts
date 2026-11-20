// Registo de atividade da equipa (plano com "Gestão avançada"): quem fez o quê no restaurante, do mais recente para o mais antigo.
// Lê o registo de auditoria com o perfil do gerente (a base de dados só lhe mostra as linhas do seu restaurante) e escreve cada linha
// em frase legível: nunca devolve endereços IP, e-mails nem dados técnicos.
import { ActivityQuery } from '../../../../shared/schemas';
import { describeActivity } from '../../../../shared/activity';
import type { ActivityEntry } from '../../../../shared/types';
import { iso } from '../../db/client';
import { badRequest } from '../../lib/errors';
import { requireFeature } from '../../lib/plans';
import { json } from '../../http/respond';
import type { Ctx, RouteSpec } from '../../http/types';

const DEFAULT_LIMIT = 40;

interface Row {
  entry_id: string;
  created_at: Date;
  action: string;
  actor_id: string | null;
  actor_role: string | null;
  metadata: unknown;
}

async function list(ctx: Ctx): Promise<Response> {
  const parsed = ActivityQuery.safeParse(Object.fromEntries(ctx.url.searchParams));
  if (!parsed.success) throw badRequest('Pedido inválido.', parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })), 'VALIDATION_ERROR');
  const a = ctx.auth!;
  const rid = a.restaurantId!;
  await requireFeature(ctx.deps.db, rid, 'advanced_management', 'o registo de atividade da equipa');

  const limit = parsed.data.limit ?? DEFAULT_LIMIT;
  const before = parsed.data.before ?? null;
  const { rows, currency } = await ctx.deps.db.as({ role: 'manager', restaurantId: rid, userId: a.userId }, async (tx) => {
    const [r] = await tx<{ currency: string }>`SELECT currency FROM restaurants WHERE id = ${rid}`;
    // as ações da plataforma (platform.*) nunca aparecem aqui; "limit + 1" serve para saber se há mais.
    // (o texto do id tem outro nome de propósito: com o mesmo nome, ORDER BY id ordenaria como texto — "9" antes de "10")
    const found = before
      ? await tx<Row>`
          SELECT id::text AS entry_id, created_at, action, actor_id, actor_role, metadata FROM audit_logs
          WHERE restaurant_id = ${rid} AND action NOT LIKE 'platform.%' AND id < ${before}::bigint
          ORDER BY id DESC LIMIT ${limit + 1}`
      : await tx<Row>`
          SELECT id::text AS entry_id, created_at, action, actor_id, actor_role, metadata FROM audit_logs
          WHERE restaurant_id = ${rid} AND action NOT LIKE 'platform.%'
          ORDER BY id DESC LIMIT ${limit + 1}`;
    return { rows: found, currency: r?.currency ?? 'AOA' };
  });

  const page = rows.slice(0, limit);
  // os nomes vêm da tabela de contas (a que o perfil do gerente não acede): só se leem membros DESTE restaurante
  const actorIds = [...new Set(page.map((r) => r.actor_id).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (actorIds.length > 0) {
    const members = await ctx.deps.db.system((tx) =>
      tx<{ user_id: string; name: string }>`
        SELECT m.user_id, u.name FROM restaurant_members m JOIN users u ON u.id = m.user_id
        WHERE m.restaurant_id = ${rid} AND m.user_id = ANY(${actorIds}::uuid[])`,
    );
    for (const m of members) names.set(m.user_id, m.name);
  }

  const entries: ActivityEntry[] = page.map((r) => ({
    id: r.entry_id,
    at: iso(r.created_at)!,
    actor_name: r.actor_id ? (names.get(r.actor_id) ?? null) : null,
    actor_role: r.actor_role,
    text: describeActivity(r.action, r.metadata, currency),
  }));
  return json({ entries, next_before: rows.length > limit ? page[page.length - 1]!.entry_id : null });
}

export const activityRoutes: RouteSpec[] = [
  { method: 'GET', path: '/api/activity', access: { roles: ['manager'] }, handler: list, limits: [{ name: 'activity', max: 60, windowMs: 60_000 }] },
];
