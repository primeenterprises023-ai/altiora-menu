// PDF dos QR Codes, pronto a imprimir: cartões das mesas (4 por folha) e a folha do restaurante.
// Só o gerente os descarrega (os QR Codes das mesas são códigos secretos que identificam a mesa).
import { uuid } from '../../../../shared/schemas';
import { audit } from '../../lib/audit';
import { HttpError, notFound } from '../../lib/errors';
import { requireFeature, restaurantFeatures } from '../../lib/plans';
import { restaurantSheetPdf, tableCardsPdf, type SheetBrand } from '../../lib/qr-sheets';
import type { Ctx, RouteSpec } from '../../http/types';

interface RestaurantRow {
  name: string;
  slug: string;
  accent_color: string | null;
  menu_base_url: string | null;
}

const MAX_TABLES = 200;

function pdfResponse(bytes: Uint8Array<ArrayBuffer>, filename: string): Response {
  return new Response(bytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${filename}"`,
      // os códigos das mesas são secretos: nada de guardar o ficheiro em caches partilhadas
      'cache-control': 'no-store',
    },
  });
}

async function loadBrand(ctx: Ctx): Promise<{ brand: SheetBrand; row: RestaurantRow; baseUrl: string }> {
  const a = ctx.auth!;
  const rid = a.restaurantId!;
  const row = await ctx.deps.db.as({ role: 'manager', restaurantId: rid, userId: a.userId }, async (tx) => {
    const [r] = await tx<RestaurantRow>`SELECT name, slug, accent_color, menu_base_url FROM restaurants WHERE id = ${rid}`;
    return r ?? null;
  });
  if (!row) throw notFound('Restaurante não encontrado.', 'RESTAURANT_NOT_FOUND');
  const features = await restaurantFeatures(ctx.deps.db, rid);
  return {
    row,
    baseUrl: row.menu_base_url ?? ctx.deps.config.publicBaseUrl,
    brand: {
      restaurantName: row.name,
      // a cor do restaurante só aparece se o plano inclui personalização avançada
      accent: features.has('advanced_branding') ? row.accent_color : null,
      showBrand: !features.has('exclusive_branding'),
    },
  };
}

const safeName = (slug: string) => slug.replace(/[^a-z0-9-]/gi, '').slice(0, 60) || 'restaurante';

async function restaurantPdf(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  await requireFeature(ctx.deps.db, a.restaurantId!, 'qr_codes', 'o QR Code do restaurante em PDF');
  const { brand, row, baseUrl } = await loadBrand(ctx);
  const bytes = restaurantSheetPdf(`${baseUrl}/r/${row.slug}`, brand);
  await ctx.deps.db.as({ role: 'manager', restaurantId: a.restaurantId!, userId: a.userId }, (tx) =>
    audit(tx, { restaurantId: a.restaurantId!, actorId: a.userId, actorRole: a.role, action: 'qr.download', entityType: 'restaurant', entityId: a.restaurantId!, metadata: { kind: 'restaurant' }, ip: ctx.ip }),
  );
  return pdfResponse(bytes, `qr-${safeName(row.slug)}.pdf`);
}

async function tablesPdf(ctx: Ctx): Promise<Response> {
  const a = ctx.auth!;
  const rid = a.restaurantId!;
  await requireFeature(ctx.deps.db, rid, 'tables', 'os QR Codes por mesa');
  const rawIds = ctx.url.searchParams.get('ids');
  let wanted: string[] | null = null;
  if (rawIds) {
    wanted = rawIds.split(',').map((s) => s.trim()).filter(Boolean);
    if (wanted.length > MAX_TABLES || wanted.some((id) => !uuid.safeParse(id).success)) throw new HttpError(400, 'INVALID_IDS', 'Lista de mesas inválida.');
  }
  const { brand, row, baseUrl } = await loadBrand(ctx);
  const tables = await ctx.deps.db.as({ role: 'manager', restaurantId: rid, userId: a.userId }, async (tx) => {
    const rows = await tx<{ id: string; table_number: number; label: string | null; qr_token: string; active: boolean }>`
      SELECT id, table_number, label, qr_token, active FROM restaurant_tables WHERE restaurant_id = ${rid} ORDER BY table_number LIMIT ${MAX_TABLES}`;
    const picked = wanted ? rows.filter((t) => wanted.includes(t.id)) : rows.filter((t) => t.active);
    await audit(tx, { restaurantId: rid, actorId: a.userId, actorRole: a.role, action: 'qr.download', entityType: 'restaurant', entityId: rid, metadata: { kind: 'tables', count: picked.length }, ip: ctx.ip });
    return picked;
  });
  if (wanted && tables.length === 0) throw notFound('Mesa não encontrada.', 'TABLE_NOT_FOUND');
  const bytes = tableCardsPdf(tables.map((t) => ({ number: t.table_number, label: t.label, url: `${baseUrl}/menu/${t.qr_token}` })), brand);
  return pdfResponse(bytes, `qr-${safeName(row.slug)}-mesas.pdf`);
}

export const qrRoutes: RouteSpec[] = [
  { method: 'GET', path: '/api/qr/restaurant.pdf', access: { roles: ['manager'] }, handler: restaurantPdf, limits: [{ name: 'qr-pdf', max: 30, windowMs: 60_000 }] },
  { method: 'GET', path: '/api/qr/tables.pdf', access: { roles: ['manager'] }, handler: tablesPdf, limits: [{ name: 'qr-pdf', max: 30, windowMs: 60_000 }] },
];
