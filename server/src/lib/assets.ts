// Fotografias e modelos 3D enviados pelos restaurantes: validação do conteúdo (pelo que o ficheiro É, não pelo que diz ser)
// e limpeza dos que deixaram de ser usados.
import type { Tx } from '../db/client';

export interface ParsedAsset {
  kind: 'image' | 'model';
  contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'model/gltf-binary';
  width: number | null;
  height: number | null;
}

export class AssetError extends Error {}

const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const be32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const be16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

/** Largura e altura de um JPEG (procura o primeiro bloco SOFn). */
function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o += 1;
      continue;
    }
    const len = be16(b, o + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: be16(b, o + 5), width: be16(b, o + 7) };
    }
    o += 2 + len;
  }
  return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  const fmt = ascii(b, 12, 4);
  if (fmt === 'VP8 ' && b.length > 30) return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff };
  if (fmt === 'VP8L' && b.length > 25) {
    const bits = u32(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (fmt === 'VP8X' && b.length > 30) return { width: (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1, height: (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1 };
  return null;
}

/** Extensões do glTF que o visualizador sabe mostrar. Compressões que precisam de descodificadores extra ficam de fora. */
const SUPPORTED_EXTENSIONS = new Set([
  'KHR_materials_unlit', 'KHR_materials_emissive_strength', 'KHR_materials_clearcoat', 'KHR_materials_sheen', 'KHR_materials_specular',
  'KHR_materials_ior', 'KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_pbrSpecularGlossiness', 'KHR_texture_transform',
  'KHR_mesh_quantization', 'KHR_lights_punctual',
]);

function parseGlb(b: Uint8Array): void {
  if (b.length < 20 || ascii(b, 0, 4) !== 'glTF') throw new AssetError('O ficheiro não é um modelo 3D no formato GLB.');
  if (u32(b, 4) !== 2) throw new AssetError('Só se aceitam modelos GLB da versão 2.');
  if (u32(b, 8) !== b.length) throw new AssetError('O modelo 3D está incompleto ou danificado.');
  const jsonLen = u32(b, 12);
  if (ascii(b, 16, 4) !== 'JSON' || 20 + jsonLen > b.length) throw new AssetError('O modelo 3D está danificado.');
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(20, 20 + jsonLen)));
  } catch {
    throw new AssetError('O modelo 3D está danificado.');
  }
  const required = Array.isArray(doc.extensionsRequired) ? (doc.extensionsRequired as unknown[]) : [];
  for (const ext of required) {
    if (typeof ext !== 'string' || !SUPPORTED_EXTENSIONS.has(ext)) {
      throw new AssetError('O modelo usa compressão (Draco, Meshopt ou KTX2) que não é suportada. Exporte o modelo GLB sem compressão.');
    }
  }
  // um modelo não pode ir buscar nada à internet: tudo tem de estar dentro do ficheiro
  for (const key of ['buffers', 'images'] as const) {
    const list = doc[key];
    if (Array.isArray(list)) {
      for (const entry of list as Array<{ uri?: unknown }>) {
        if (typeof entry?.uri === 'string' && !entry.uri.startsWith('data:')) throw new AssetError('O modelo depende de ficheiros externos. Exporte um GLB com tudo incluído.');
      }
    }
  }
  if (!Array.isArray(doc.meshes) || doc.meshes.length === 0) throw new AssetError('O modelo 3D não tem nenhuma forma para mostrar.');
}

/** Confere o conteúdo pelos primeiros bytes (e a estrutura, nos modelos). Lança AssetError com uma frase para o utilizador. */
export function inspectAsset(bytes: Uint8Array): ParsedAsset {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const s = jpegSize(bytes);
    if (!s) throw new AssetError('A fotografia está danificada.');
    return { kind: 'image', contentType: 'image/jpeg', ...s };
  }
  if (bytes.length >= 33 && ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n' && ascii(bytes, 12, 4) === 'IHDR') {
    return { kind: 'image', contentType: 'image/png', width: be32(bytes, 16), height: be32(bytes, 20) };
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const s = webpSize(bytes);
    if (!s) throw new AssetError('A fotografia está danificada.');
    return { kind: 'image', contentType: 'image/webp', ...s };
  }
  if (bytes.length >= 20 && ascii(bytes, 0, 4) === 'glTF') {
    parseGlb(bytes);
    return { kind: 'model', contentType: 'model/gltf-binary', width: null, height: null };
  }
  throw new AssetError('Formato não aceite. Envie fotografias JPG, PNG ou WebP, ou modelos 3D GLB.');
}

const ASSET_URL = /^\/a\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const assetIdFromUrl = (url: string | null | undefined): string | null => (url ? ASSET_URL.exec(url)?.[1] ?? null : null);

/**
 * Apaga os ficheiros do restaurante que já não são usados por nenhum prato nem pelo logótipo/capa.
 * Os enviados há menos de 15 minutos ficam: podem estar a ser anexados neste momento.
 */
export async function purgeOrphanAssets(tx: Tx, restaurantId: string): Promise<number> {
  const rows = await tx`
    DELETE FROM assets a
    WHERE a.restaurant_id = ${restaurantId}
      AND a.created_at < now() - interval '15 minutes'
      AND NOT EXISTS (SELECT 1 FROM restaurants r WHERE r.id = a.restaurant_id AND ('/a/' || a.id::text) IN (r.logo_url, r.cover_url))
      AND NOT EXISTS (SELECT 1 FROM menu_items i WHERE i.restaurant_id = a.restaurant_id AND ('/a/' || a.id::text) IN (i.image_url, i.thumb_url, i.model_url))
    RETURNING a.id`;
  return rows.length;
}
