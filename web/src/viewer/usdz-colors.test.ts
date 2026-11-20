// Cor por vértice → textura, para a realidade aumentada no iPhone (ver usdz-colors.ts). Sem aparelho: simula-se o que a placa gráfica faz
// (ler a textura com interpolação) e compara-se com a cor que o modelo tem em cada vértice, incluindo os modelos de demonstração verdadeiros.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bakeVertexColorsForUsdz, fitColorPlane, FLAT_TOLERANCE, PLANE_SIZE, planePixels, planeUv, srgb8, type CanvasLike, type Vec3 } from './usdz-colors';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const kit = {
  CanvasTexture: THREE.CanvasTexture,
  Float32BufferAttribute: THREE.Float32BufferAttribute,
  SRGBColorSpace: THREE.SRGBColorSpace,
  ClampToEdgeWrapping: THREE.ClampToEdgeWrapping,
};

/** Um "canvas" que guarda os pontos desenhados (o Bun não tem canvas). */
interface FakeCanvas extends CanvasLike {
  pixels: Uint8ClampedArray | null;
}
function fakeCanvas(): FakeCanvas {
  const canvas: FakeCanvas = {
    width: 0,
    height: 0,
    pixels: null,
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (image: Any) => {
        canvas.pixels = image.data;
      },
    }),
  };
  return canvas;
}

const srgbToLinear = (byte: number): number => {
  const s = byte / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

/** Lê a textura como a placa gráfica: interpolação bilinear em espaço linear, margens repetidas (clamp). */
function sample(pixels: Uint8ClampedArray, size: number, u: number, v: number): Vec3 {
  const x = u * size - 0.5;
  const y = v * size - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (i: number, j: number, c: number): number => {
    const ci = Math.min(size - 1, Math.max(0, i));
    const cj = Math.min(size - 1, Math.max(0, j));
    return srgbToLinear(pixels[(cj * size + ci) * 4 + c]);
  };
  const out: Vec3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx;
    const bottom = at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
  return out;
}

/** Números "aleatórios" sempre iguais. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const dist = (a: ArrayLike<number>, b: ArrayLike<number>): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('srgb8', () => {
  test('extremos, ponto médio e valores fora de 0–1', () => {
    expect(srgb8(0)).toBe(0);
    expect(srgb8(1)).toBe(255);
    expect(srgb8(0.2159)).toBe(128); // cinzento médio em sRGB (128/255)
    expect(srgb8(-3)).toBe(0);
    expect(srgb8(7)).toBe(255);
  });
  test('é o inverso da conversão usada para ler', () => {
    for (let byte = 0; byte <= 255; byte++) expect(srgb8(srgbToLinear(byte))).toBe(byte);
  });
});

describe('fitColorPlane + planePixels + planeUv', () => {
  test('cores num plano do espaço RGB são reproduzidas quase exatamente', () => {
    const random = prng(7);
    const count = 600;
    const rgb = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const a = (random() - 0.5) * 0.7;
      const b = (random() - 0.5) * 0.4;
      rgb[i * 3] = 0.55 + a * 0.5 + b * 0.1;
      rgb[i * 3 + 1] = 0.3 - a * 0.3 + b * 0.4;
      rgb[i * 3 + 2] = 0.12 + a * 0.1 + b * 0.2;
    }
    const plane = fitColorPlane(rgb, count);
    expect(plane.flat).toBe(false);
    expect(plane.maxError).toBeLessThan(1e-4);
    const pixels = planePixels(plane);
    const uv = planeUv(plane, rgb, count);
    let worst = 0;
    for (let i = 0; i < count; i++) worst = Math.max(worst, dist(sample(pixels, PLANE_SIZE, uv[i * 2], uv[i * 2 + 1]), [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]));
    expect(worst).toBeLessThan(0.01);
  });

  test('os eixos do plano são perpendiculares e de comprimento 1', () => {
    const random = prng(11);
    const rgb = new Float32Array(300);
    for (let i = 0; i < 100; i++) {
      rgb[i * 3] = random();
      rgb[i * 3 + 1] = random() * 0.5;
      rgb[i * 3 + 2] = random() * 0.2;
    }
    const { e1, e2 } = fitColorPlane(rgb, 100);
    expect(Math.hypot(...e1)).toBeCloseTo(1, 6);
    expect(Math.hypot(...e2)).toBeCloseTo(1, 6);
    expect(Math.abs(e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2])).toBeLessThan(1e-6);
  });

  test('uma variação só (de um tom claro para um escuro) também fica certa', () => {
    const count = 200;
    const rgb = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      rgb[i * 3] = 0.9 - 0.5 * t;
      rgb[i * 3 + 1] = 0.5 - 0.35 * t;
      rgb[i * 3 + 2] = 0.1 - 0.08 * t;
    }
    const plane = fitColorPlane(rgb, count);
    const pixels = planePixels(plane);
    const uv = planeUv(plane, rgb, count);
    let worst = 0;
    for (let i = 0; i < count; i++) worst = Math.max(worst, dist(sample(pixels, PLANE_SIZE, uv[i * 2], uv[i * 2 + 1]), [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]));
    expect(worst).toBeLessThan(0.01);
  });

  test('uma só cor (com ruído mínimo) fica "plana", sem textura', () => {
    const random = prng(3);
    const count = 50;
    const rgb = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      rgb[i * 3] = 0.2 + (random() - 0.5) * FLAT_TOLERANCE * 0.5;
      rgb[i * 3 + 1] = 0.6;
      rgb[i * 3 + 2] = 0.1;
    }
    const plane = fitColorPlane(rgb, count);
    expect(plane.flat).toBe(true);
    expect(plane.mean[0]).toBeCloseTo(0.2, 2);
    expect(plane.mean[1]).toBeCloseTo(0.6, 5);
  });

  test('as coordenadas ficam sempre no centro de pontos da textura (nunca na margem)', () => {
    const random = prng(5);
    const count = 300;
    const rgb = new Float32Array(count * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = random();
    const plane = fitColorPlane(rgb, count);
    const uv = planeUv(plane, rgb, count);
    const min = 0.5 / PLANE_SIZE;
    const max = 1 - 0.5 / PLANE_SIZE;
    for (const value of uv) {
      expect(value).toBeGreaterThanOrEqual(min - 1e-6);
      expect(value).toBeLessThanOrEqual(max + 1e-6);
    }
  });
});

function quad(colors: number[], material: Any): Any {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return new THREE.Mesh(geometry, material);
}

describe('bakeVertexColorsForUsdz', () => {
  const GRADIENT = [0.9, 0.5, 0.1, 0.7, 0.3, 0.05, 0.4, 0.2, 0.02, 0.2, 0.1, 0.01];

  test('uma peça com cores diferentes ganha textura e coordenadas; o original não muda', () => {
    const material = new THREE.MeshStandardMaterial({ vertexColors: true });
    const mesh = quad(GRADIENT, material);
    const group = new THREE.Group();
    group.add(mesh);
    const copy = group.clone(true);
    const canvases: FakeCanvas[] = [];
    const result = bakeVertexColorsForUsdz(copy, kit, () => {
      const canvas = fakeCanvas();
      canvases.push(canvas);
      return canvas;
    });
    expect(result).toMatchObject({ textured: 1, flat: 0, untouched: 0 });
    expect(result.maxError).toBeLessThan(0.01);

    const baked = copy.children[0];
    expect(baked.geometry.attributes.uv.count).toBe(4);
    expect(baked.geometry.attributes.color).toBeUndefined();
    expect(baked.material.vertexColors).toBe(false);
    expect(baked.material.map).toBeTruthy();
    expect(baked.material.map.flipY).toBe(false);
    expect(baked.material.map.colorSpace).toBe(THREE.SRGBColorSpace);
    expect([baked.material.color.r, baked.material.color.g, baked.material.color.b]).toEqual([1, 1, 1]);
    expect(canvases).toHaveLength(1);
    expect(canvases[0].width).toBe(PLANE_SIZE);

    // o original (o que se vê no ecrã) ficou como estava
    expect(mesh.geometry.attributes.color).toBeTruthy();
    expect(mesh.geometry.attributes.uv).toBeUndefined();
    expect(mesh.material.vertexColors).toBe(true);
    expect(mesh.material.map).toBeNull();
    expect(baked.geometry).not.toBe(mesh.geometry);
    expect(baked.material).not.toBe(mesh.material);
  });

  test('a textura devolve, em cada vértice, a cor do modelo (cor do material × cor por vértice)', () => {
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, color: new THREE.Color().setRGB(0.8, 0.9, 0.7) });
    const group = new THREE.Group();
    group.add(quad(GRADIENT, material));
    const copy = group.clone(true);
    const canvases: FakeCanvas[] = [];
    bakeVertexColorsForUsdz(copy, kit, () => {
      const canvas = fakeCanvas();
      canvases.push(canvas);
      return canvas;
    });
    const uv = copy.children[0].geometry.attributes.uv;
    for (let i = 0; i < 4; i++) {
      const expected: Vec3 = [0.8 * GRADIENT[i * 3], 0.9 * GRADIENT[i * 3 + 1], 0.7 * GRADIENT[i * 3 + 2]];
      expect(dist(sample(canvases[0].pixels!, PLANE_SIZE, uv.getX(i), uv.getY(i)), expected)).toBeLessThan(0.01);
    }
  });

  test('uma peça de uma só cor passa a cor para o material, sem textura', () => {
    const material = new THREE.MeshStandardMaterial({ vertexColors: true });
    const group = new THREE.Group();
    group.add(quad([0.3, 0.6, 0.1, 0.3, 0.6, 0.1, 0.3, 0.6, 0.1, 0.3, 0.6, 0.1], material));
    const copy = group.clone(true);
    const result = bakeVertexColorsForUsdz(copy, kit, fakeCanvas);
    expect(result).toMatchObject({ textured: 0, flat: 1, untouched: 0 });
    const baked = copy.children[0];
    expect(baked.material.map).toBeNull();
    expect(baked.material.vertexColors).toBe(false);
    expect(baked.geometry.attributes.color).toBeUndefined();
    expect([baked.material.color.r, baked.material.color.g, baked.material.color.b].map((x: number) => Number(x.toFixed(4)))).toEqual([0.3, 0.6, 0.1]);
  });

  test('não mexe no que não consegue converter: já tem textura, vários materiais, ou nem tem cor por vértice', () => {
    const group = new THREE.Group();
    const withMap = quad(GRADIENT, new THREE.MeshStandardMaterial({ vertexColors: true, map: new THREE.Texture() }));
    const multi = quad(GRADIENT, [new THREE.MeshStandardMaterial({ vertexColors: true }), new THREE.MeshStandardMaterial({ vertexColors: true })]);
    const ignored = quad(GRADIENT, new THREE.MeshStandardMaterial({ vertexColors: false })); // a cor por vértice nem sequer é usada
    const plain = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xff0000 }));
    group.add(withMap, multi, ignored, plain);
    const copy = group.clone(true);
    const result = bakeVertexColorsForUsdz(copy, kit, fakeCanvas);
    expect(result).toMatchObject({ textured: 0, flat: 0, untouched: 3 });
    copy.children.forEach((child: Any, i: number) => {
      const before = group.children[i];
      expect(child.geometry).toBe(before.geometry);
      // (num mesh com vários materiais o Three.js copia a lista, mas os materiais são os mesmos)
      const kept: Any[] = Array.isArray(child.material) ? child.material : [child.material];
      const original: Any[] = Array.isArray(before.material) ? before.material : [before.material];
      expect(kept).toHaveLength(original.length);
      kept.forEach((material, k) => expect(material).toBe(original[k]));
    });
  });

  test('um canvas que falha deixa a peça como estava, sem rebentar', () => {
    const group = new THREE.Group();
    group.add(quad(GRADIENT, new THREE.MeshStandardMaterial({ vertexColors: true })));
    const copy = group.clone(true);
    const result = bakeVertexColorsForUsdz(copy, kit, () => ({ width: 0, height: 0, getContext: () => null }));
    expect(result).toMatchObject({ textured: 0, untouched: 1 });
    expect(copy.children[0].geometry).toBe(group.children[0].geometry);
  });
});

describe('modelos de demonstração (os GLB verdadeiros)', () => {
  const dir = join(import.meta.dir, '../../../scripts/demo-media/assets');
  const files = readdirSync(dir).filter((name) => name.endsWith('.glb'));

  test('há modelos para testar', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  for (const file of files) {
    test(`${file}: depois da conversão, cada vértice tem a mesma cor que no modelo (erro < 0,02)`, async () => {
      const bytes = readFileSync(join(dir, file));
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const gltf: Any = await new Promise((resolve, reject) => new GLTFLoader().parse(arrayBuffer, '', resolve, reject));
      const original: Any[] = [];
      gltf.scene.traverse((o: Any) => {
        if (o.isMesh) original.push(o);
      });
      const copy = gltf.scene.clone(true);
      const textures = new Map<Any, FakeCanvas>();
      const result = bakeVertexColorsForUsdz(copy, kit, () => fakeCanvas());
      const baked: Any[] = [];
      copy.traverse((o: Any) => {
        if (o.isMesh) baked.push(o);
      });
      expect(baked).toHaveLength(original.length);
      expect(result.untouched).toBe(0);
      expect(result.textured + result.flat).toBeGreaterThan(0);

      let worst = 0;
      let vertices = 0;
      for (let m = 0; m < original.length; m++) {
        const before = original[m];
        const after = baked[m];
        const colors = before.geometry.attributes.color;
        if (!colors) {
          expect(after.geometry).toBe(before.geometry); // peças sem cor por vértice ficam intactas
          continue;
        }
        // o original não foi alterado
        expect(before.geometry.attributes.color).toBeTruthy();
        expect(before.material.vertexColors).toBe(true);
        expect(after.geometry.attributes.color).toBeUndefined();
        const tint = before.material.color;
        const map = after.material.map;
        for (let i = 0; i < colors.count; i++) {
          const expected: Vec3 = [tint.r * colors.getX(i), tint.g * colors.getY(i), tint.b * colors.getZ(i)];
          let got: Vec3;
          if (map) {
            const canvas = map.image as FakeCanvas;
            textures.set(map, canvas);
            got = sample(canvas.pixels!, PLANE_SIZE, after.geometry.attributes.uv.getX(i), after.geometry.attributes.uv.getY(i));
          } else {
            got = [after.material.color.r, after.material.color.g, after.material.color.b];
          }
          worst = Math.max(worst, dist(got, expected));
          vertices++;
        }
      }
      expect(vertices).toBeGreaterThan(100);
      expect(worst).toBeLessThan(0.02);
    });
  }
});
