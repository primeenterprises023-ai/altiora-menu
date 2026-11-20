// Realidade aumentada no iPhone/iPad (AR Quick Look): o USDZ que o Three.js escreve guarda a "cor por vértice" num campo que o Quick Look
// não usa, e os pratos apareceriam todos brancos. Por isso, antes de exportar, cada peça com cor por vértice recebe uma pequena textura
// com as suas cores, e cada vértice aponta para o sítio certo dessa textura.
//
// Como funciona, sem perder suavidade e sem duplicar vértices:
//   1. As cores de uma peça de comida variam quase sempre dentro de um plano do espaço RGB (tons da mesma cor). Encontramos esse plano
//      (análise de componentes principais) e desenhamos nele uma textura de 32×32 pontos.
//   2. Cada vértice usa, como coordenadas da textura, a posição da sua cor nesse plano. Como a cor varia linearmente no plano, a
//      interpolação da textura entre vértices dá a mesma cor que a interpolação das cores do modelo. Nos modelos de demonstração o erro
//      máximo é inferior a 0,01 (numa escala de 0 a 1).
//   3. Uma peça de uma só cor não precisa de textura: a cor passa para o material.
// O modelo que se vê no ecrã não é alterado: trabalhamos numa cópia, só para o ficheiro de realidade aumentada.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
export type Vec3 = [number, number, number];

/** Pontos por lado da textura de cada peça. */
export const PLANE_SIZE = 32;
/** Peças cujas cores se afastam menos do que isto (0 a 1, espaço linear) da média ficam com uma cor única, sem textura. */
export const FLAT_TOLERANCE = 0.01;

export interface ColorPlane {
  mean: Vec3;
  e1: Vec3;
  e2: Vec3;
  min1: number;
  max1: number;
  min2: number;
  max2: number;
  /** Todas as cores estão a menos de FLAT_TOLERANCE da média. */
  flat: boolean;
  /** Maior distância (no espaço RGB linear) entre uma cor e a sua aproximação pelo plano. */
  maxError: number;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 1e-12 ? [v[0] / length, v[1] / length, v[2] / length] : [1, 0, 0];
};

/** Maior vetor próprio de uma matriz simétrica 3×3 (iteração de potência). */
function dominantAxis(m: number[][], start: Vec3): Vec3 {
  let v = unit(start);
  for (let i = 0; i < 64; i++) {
    const next: Vec3 = [
      m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
      m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
      m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ];
    if (Math.hypot(next[0], next[1], next[2]) < 1e-14) break; // matriz (quase) nula: qualquer direção serve
    v = unit(next);
  }
  return v;
}

/** Ajusta um plano às cores (`rgb` = r,g,b,r,g,b… em espaço linear). */
export function fitColorPlane(rgb: ArrayLike<number>, count: number): ColorPlane {
  const mean: Vec3 = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    mean[0] += rgb[i * 3];
    mean[1] += rgb[i * 3 + 1];
    mean[2] += rgb[i * 3 + 2];
  }
  if (count > 0) {
    mean[0] /= count;
    mean[1] /= count;
    mean[2] /= count;
  }

  // cor mais afastada da média, para decidir se a peça é de uma só cor
  let spread = 0;
  for (let i = 0; i < count; i++) {
    spread = Math.max(spread, Math.hypot(rgb[i * 3] - mean[0], rgb[i * 3 + 1] - mean[1], rgb[i * 3 + 2] - mean[2]));
  }
  if (spread <= FLAT_TOLERANCE) {
    return { mean, e1: [1, 0, 0], e2: [0, 1, 0], min1: 0, max1: 0, min2: 0, max2: 0, flat: true, maxError: spread };
  }

  // matriz de covariância
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < count; i++) {
    const d = [rgb[i * 3] - mean[0], rgb[i * 3 + 1] - mean[1], rgb[i * 3 + 2] - mean[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a][b] += (d[a] * d[b]) / count;
  }
  const e1 = dominantAxis(cov, [1, 0.7, 0.3]);
  // retira a variação ao longo do primeiro eixo (λ = e1ᵀ·cov·e1) para achar o segundo
  const lambda1 = e1.reduce((sum, ea, a) => sum + ea * (cov[a][0] * e1[0] + cov[a][1] * e1[1] + cov[a][2] * e1[2]), 0);
  const rest = cov.map((row, a) => row.map((x, b) => x - lambda1 * e1[a] * e1[b]));
  let e2 = dominantAxis(rest, [0.3, 1, -0.5]);
  // o segundo eixo tem de ser perpendicular ao primeiro (senão a reconstrução conta a mesma variação duas vezes)
  const along = dot(e2, e1);
  e2 = unit([e2[0] - along * e1[0], e2[1] - along * e1[1], e2[2] - along * e1[2]]);
  if (Math.abs(dot(e2, e1)) > 1e-6) e2 = unit([e1[1], -e1[0], 0]);

  let min1 = Infinity;
  let max1 = -Infinity;
  let min2 = Infinity;
  let max2 = -Infinity;
  const coords: number[] = new Array(count * 2);
  let maxError = 0;
  for (let i = 0; i < count; i++) {
    const d: Vec3 = [rgb[i * 3] - mean[0], rgb[i * 3 + 1] - mean[1], rgb[i * 3 + 2] - mean[2]];
    const t1 = dot(d, e1);
    const t2 = dot(d, e2);
    coords[i * 2] = t1;
    coords[i * 2 + 1] = t2;
    min1 = Math.min(min1, t1);
    max1 = Math.max(max1, t1);
    min2 = Math.min(min2, t2);
    max2 = Math.max(max2, t2);
    maxError = Math.max(maxError, Math.hypot(d[0] - t1 * e1[0] - t2 * e2[0], d[1] - t1 * e1[1] - t2 * e2[1], d[2] - t1 * e1[2] - t2 * e2[2]));
  }
  return { mean, e1, e2, min1, max1, min2, max2, flat: false, maxError };
}

/** 0–1 (linear) → 0–255 (sRGB). */
export function srgb8(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/** Pixels (RGBA, sRGB) da textura do plano: a linha j (de cima para baixo) e a coluna i guardam a cor do ponto (i, j) do plano. */
export function planePixels(plane: ColorPlane, size: number = PLANE_SIZE): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  const step = size > 1 ? size - 1 : 1;
  for (let j = 0; j < size; j++) {
    const t2 = plane.min2 + (j / step) * (plane.max2 - plane.min2);
    for (let i = 0; i < size; i++) {
      const t1 = plane.min1 + (i / step) * (plane.max1 - plane.min1);
      const at = (j * size + i) * 4;
      out[at] = srgb8(plane.mean[0] + t1 * plane.e1[0] + t2 * plane.e2[0]);
      out[at + 1] = srgb8(plane.mean[1] + t1 * plane.e1[1] + t2 * plane.e2[1]);
      out[at + 2] = srgb8(plane.mean[2] + t1 * plane.e1[2] + t2 * plane.e2[2]);
      out[at + 3] = 255;
    }
  }
  return out;
}

/**
 * Coordenadas da textura (convenção do glTF: v conta de cima para baixo) de cada vértice. Ficam sempre no centro de pontos da textura,
 * por isso nunca se lê um ponto vizinho de fora do plano.
 */
export function planeUv(plane: ColorPlane, rgb: ArrayLike<number>, count: number, size: number = PLANE_SIZE): Float32Array {
  const uv = new Float32Array(count * 2);
  const range1 = plane.max1 - plane.min1;
  const range2 = plane.max2 - plane.min2;
  const step = size > 1 ? size - 1 : 1;
  for (let i = 0; i < count; i++) {
    const d: Vec3 = [rgb[i * 3] - plane.mean[0], rgb[i * 3 + 1] - plane.mean[1], rgb[i * 3 + 2] - plane.mean[2]];
    const s1 = range1 > 1e-9 ? Math.min(1, Math.max(0, (dot(d, plane.e1) - plane.min1) / range1)) : 0;
    const s2 = range2 > 1e-9 ? Math.min(1, Math.max(0, (dot(d, plane.e2) - plane.min2) / range2)) : 0;
    uv[i * 2] = (0.5 + s1 * step) / size;
    uv[i * 2 + 1] = (0.5 + s2 * step) / size;
  }
  return uv;
}

// --- aplicação a um modelo do Three.js ------------------------------------------------------------------------

/** O que a função precisa do Three.js (passado de fora para o motor 3D continuar a carregar só o que usa). */
export interface BakeKit {
  CanvasTexture: Any;
  Float32BufferAttribute: Any;
  SRGBColorSpace: Any;
  ClampToEdgeWrapping: Any;
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: '2d'): {
    createImageData(width: number, height: number): { data: Uint8ClampedArray };
    putImageData(image: Any, x: number, y: number): void;
  } | null;
}

export interface BakeResult {
  /** Peças que ganharam uma textura. */
  textured: number;
  /** Peças de uma só cor (cor passada para o material). */
  flat: number;
  /** Peças com cor por vértice que não foi possível converter (ficam como estão). */
  untouched: number;
  /** Maior erro de cor (0–1, espaço linear) entre as peças com textura. */
  maxError: number;
}

const OTHER_MAPS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'clearcoatMap', 'sheenColorMap', 'specularColorMap', 'transmissionMap'];

function defaultCanvas(size: number): CanvasLike {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas as unknown as CanvasLike;
}

/**
 * Converte, NUMA CÓPIA do modelo (`root`, por exemplo `cena.clone(true)`), a cor por vértice em texturas/cores de material.
 * Só mexe nas peças desta cópia: a geometria e os materiais originais (que o ecrã usa) não são alterados.
 */
export function bakeVertexColorsForUsdz(root: Any, kit: BakeKit, makeCanvas: (size: number) => CanvasLike = defaultCanvas): BakeResult {
  const result: BakeResult = { textured: 0, flat: 0, untouched: 0, maxError: 0 };
  root.traverse((object: Any) => {
    if (!object.isMesh || object.isSkinnedMesh || object.isInstancedMesh) return;
    const geometry = object.geometry;
    const material = object.material;
    const colors = geometry?.attributes?.color;
    if (!colors) return;
    if (!material || Array.isArray(material) || material.vertexColors !== true || OTHER_MAPS.some((key) => material[key])) {
      result.untouched++;
      return;
    }
    try {
      const count: number = colors.count;
      const tint = material.color;
      const rgb = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        rgb[i * 3] = tint.r * colors.getX(i);
        rgb[i * 3 + 1] = tint.g * colors.getY(i);
        rgb[i * 3 + 2] = tint.b * colors.getZ(i);
      }
      const plane = fitColorPlane(rgb, count);
      const baked = material.clone();
      baked.vertexColors = false;
      const copy = geometry.clone();
      copy.deleteAttribute('color');
      if (plane.flat) {
        baked.color.setRGB(plane.mean[0], plane.mean[1], plane.mean[2]);
        result.flat++;
      } else {
        const canvas = makeCanvas(PLANE_SIZE);
        canvas.width = PLANE_SIZE;
        canvas.height = PLANE_SIZE;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('sem canvas');
        const image = context.createImageData(PLANE_SIZE, PLANE_SIZE);
        image.data.set(planePixels(plane, PLANE_SIZE));
        context.putImageData(image, 0, 0);
        const texture = new kit.CanvasTexture(canvas);
        texture.colorSpace = kit.SRGBColorSpace; // os pontos da textura estão em sRGB
        texture.flipY = false; // as coordenadas seguem a convenção do glTF (v de cima para baixo), como nos modelos com texturas
        texture.wrapS = texture.wrapT = kit.ClampToEdgeWrapping;
        baked.map = texture;
        baked.color.setRGB(1, 1, 1);
        copy.setAttribute('uv', new kit.Float32BufferAttribute(planeUv(plane, rgb, count, PLANE_SIZE), 2));
        result.textured++;
        result.maxError = Math.max(result.maxError, plane.maxError);
      }
      object.geometry = copy;
      object.material = baked;
    } catch {
      result.untouched++;
    }
  });
  return result;
}
