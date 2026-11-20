// Motor 3D do ALTIORA MENU (Three.js, incluído em web/vendor/three). Só é carregado quando alguém toca em "Ver em 3D".
// Mostra um modelo GLB que se roda com o dedo (ou o rato), se amplia com dois dedos (ou a roda do rato) e,
// em telemóveis que o suportam, se pode ver na mesa em realidade aumentada.
// Sem WebGL ou com um modelo que não abre, avisa quem chamou (que mostra a fotografia): nunca finge um 3D.
import {
  Box3,
  CanvasTexture,
  ClampToEdgeWrapping,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  NeutralToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  Spherical,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { detectAr, sceneViewerUrl, type ArMode } from './ar';
import { bakeVertexColorsForUsdz } from './usdz-colors';
import type { ViewerHandle, ViewerOptions } from './mount';

const FIT = 1.6; // o maior lado do modelo passa a medir isto (unidades da cena)
const FOV = 35;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Sombra suave por baixo do prato (um disco com gradiente), para o modelo não parecer a flutuar. */
function shadowTexture(): unknown {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(0,0,0,0.42)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.16)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function disposeTree(root: Any): void {
  root.traverse((o: Any) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const key of Object.keys(m)) {
        const v = m[key];
        if (v && v.isTexture) {
          if (v.image && typeof v.image.close === 'function') v.image.close();
          v.dispose();
        }
      }
      m.dispose();
    }
  });
}

export async function createViewer(host: HTMLElement, opts: ViewerOptions): Promise<ViewerHandle> {
  host.classList.add('v3d');
  host.tabIndex = 0;
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', `Modelo 3D de ${opts.alt}. Use as setas para rodar e as teclas + e − para ampliar.`);

  let renderer: Any;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    host.classList.remove('v3d');
    opts.onError?.('webgl');
    return { destroy() {}, reset() {} };
  }
  const lowEnd = (navigator.hardwareConcurrency ?? 8) <= 4;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowEnd ? 1.5 : 2));
  renderer.outputColorSpace = SRGBColorSpace;
  // "Neutral" (Khronos PBR Neutral) mantém as cores do prato fiéis; o ACES, mais "cinematográfico", lavava os castanhos e vermelhos da comida
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  const canvas: HTMLCanvasElement = renderer.domElement;
  canvas.className = 'v3d-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const envScene = new RoomEnvironment();
  const envMap = pmrem.fromScene(envScene, 0.04);
  scene.environment = envMap.texture;
  scene.environmentIntensity = 0.65;
  const key = new DirectionalLight(0xffffff, 1);
  key.position.set(2.5, 4, 3);
  scene.add(key);

  const camera = new PerspectiveCamera(FOV, 1, 0.01, 100);
  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.9;
  controls.zoomSpeed = 0.8;
  controls.autoRotate = opts.autoRotate !== false;
  controls.autoRotateSpeed = 1.4;
  controls.maxPolarAngle = Math.PI * 0.53;
  controls.minPolarAngle = Math.PI * 0.12;

  // --- interface por cima do modelo -----------------------------------------------------------------
  const ui = el('div', 'v3d-ui');
  const hint = el('p', 'v3d-hint', 'Arraste para rodar · junte os dedos para ampliar');
  hint.setAttribute('aria-hidden', 'true');
  const bar = el('div', 'v3d-bar');
  const resetBtn = el('button', 'v3d-btn', 'Repor vista');
  resetBtn.type = 'button';
  bar.appendChild(resetBtn);
  ui.append(hint, bar);
  host.appendChild(ui);

  let destroyed = false;
  let raf = 0;
  let io: Any = null;
  let ro: Any = null;
  let onVisibility: (() => void) | null = null;
  let userMoved = false;
  let homePosition = new Vector3(0, 0.5, 3);
  let radius = 1;
  let holder: Any = null;
  let root: Any = null;
  let usdz: { url: string | null; building: Promise<void> | null } = { url: null, building: null };

  const frame = (): void => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // distância para o modelo caber inteiro, tanto em ecrãs altos como largos
    const vFov = (FOV * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.08;
    controls.minDistance = dist * 0.45;
    controls.maxDistance = dist * 2.4;
    const dir = homePosition.clone().normalize();
    homePosition = dir.multiplyScalar(dist);
    if (!userMoved) {
      camera.position.copy(homePosition);
      camera.lookAt(0, 0, 0);
    }
    controls.update();
  };

  const resetView = (): void => {
    userMoved = false;
    camera.position.copy(homePosition);
    controls.target.set(0, 0, 0);
    controls.autoRotate = opts.autoRotate !== false;
    controls.update();
  };
  resetBtn.addEventListener('click', resetView);

  controls.addEventListener('start', () => {
    userMoved = true;
    controls.autoRotate = false;
  });

  // teclado: setas rodam, + e − ampliam
  host.addEventListener('keydown', (e: KeyboardEvent) => {
    const step = 0.12;
    const offset = camera.position.clone().sub(controls.target);
    const s = new Spherical().setFromVector3(offset);
    let used = true;
    switch (e.key) {
      case 'ArrowLeft': s.theta -= step; break;
      case 'ArrowRight': s.theta += step; break;
      case 'ArrowUp': s.phi = Math.max(controls.minPolarAngle, s.phi - step); break;
      case 'ArrowDown': s.phi = Math.min(controls.maxPolarAngle, s.phi + step); break;
      case '+': case '=': s.radius = Math.max(controls.minDistance, s.radius * 0.88); break;
      case '-': case '_': s.radius = Math.min(controls.maxDistance, s.radius / 0.88); break;
      case 'Home': resetView(); e.preventDefault(); return;
      default: used = false;
    }
    if (!used) return;
    e.preventDefault();
    userMoved = true;
    controls.autoRotate = false;
    offset.setFromSpherical(s);
    camera.position.copy(controls.target).add(offset);
    camera.lookAt(controls.target);
  });

  // --- carregar o modelo ----------------------------------------------------------------------------
  const loader = new GLTFLoader(); // sem Draco/Meshopt: o servidor só aceita modelos sem compressão
  let gltf: Any;
  try {
    gltf = await loader.loadAsync(opts.src, (ev: ProgressEvent) => {
      if (ev.lengthComputable && ev.total > 0) opts.onProgress?.(Math.min(1, ev.loaded / ev.total));
    });
  } catch {
    cleanup();
    opts.onError?.('load');
    return { destroy() {}, reset() {} };
  }
  if (destroyed) {
    cleanup();
    return { destroy() {}, reset() {} };
  }

  root = gltf.scene;
  holder = new Group();
  holder.add(root);
  scene.add(holder);
  const box = new Box3().setFromObject(root);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const k = FIT / maxDim;
  // Raio da esfera mínima (centrada no centro da caixa) que contém todos os vértices. Num prato redondo e baixo é bem menor
  // do que a diagonal da caixa, e assim o prato enche a janela em vez de ficar pequeno ao centro.
  root.updateWorldMatrix(true, true);
  const corner = new Vector3();
  let farthest = 0;
  root.traverse((o: Any) => {
    const position = o.isMesh ? o.geometry?.attributes?.position : null;
    if (!position) return;
    for (let i = 0; i < position.count; i++) {
      corner.fromBufferAttribute(position, i).applyMatrix4(o.matrixWorld);
      farthest = Math.max(farthest, corner.distanceToSquared(center));
    }
  });
  holder.scale.setScalar(k);
  holder.position.set(-center.x * k, -center.y * k, -center.z * k);
  radius = farthest > 0 ? Math.sqrt(farthest) * k : (new Vector3(size.x, size.y, size.z).length() * k) / 2;

  const floorY = (-size.y * k) / 2;
  const shadow = new Mesh(
    new PlaneGeometry(FIT * 1.5, FIT * 1.5),
    new MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = floorY - 0.002;
  scene.add(shadow);

  homePosition = new Vector3(0, 0.45, 1).normalize();
  frame();

  // --- realidade aumentada --------------------------------------------------------------------------
  if (opts.ar) {
    detectAr().then((mode: ArMode) => {
      if (destroyed || !mode) return;
      const label = 'Ver na minha mesa';
      if (mode === 'android') {
        const b = el('button', 'v3d-btn v3d-btn-ar', label);
        b.type = 'button';
        b.addEventListener('click', () => {
          window.location.href = sceneViewerUrl(opts.src, opts.title ?? opts.alt, opts.fallbackUrl ?? window.location.href);
        });
        bar.insertBefore(b, resetBtn);
      } else {
        // iPhone/iPad: o USDZ é preparado no aparelho, a partir do mesmo modelo (tamanho real: 1 unidade = 1 metro)
        const anchor = document.createElement('a');
        anchor.className = 'v3d-btn v3d-btn-ar';
        anchor.setAttribute('rel', 'ar');
        anchor.setAttribute('aria-disabled', 'true');
        anchor.textContent = 'A preparar realidade aumentada…';
        const img = document.createElement('img');
        img.alt = '';
        img.className = 'v3d-ar-img';
        img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        anchor.appendChild(img);
        bar.insertBefore(anchor, resetBtn);
        usdz.building = (async () => {
          try {
            const { USDZExporter } = (await import('three/addons/exporters/USDZExporter.js')) as Any;
            const exportScene = new Scene();
            const forExport = root.clone(true);
            // o USDZ não leva a cor por vértice (os pratos ficariam brancos no Quick Look): passa-a para texturas, só nesta cópia
            bakeVertexColorsForUsdz(forExport, { CanvasTexture, Float32BufferAttribute, SRGBColorSpace, ClampToEdgeWrapping });
            exportScene.add(forExport);
            exportScene.updateMatrixWorld(true);
            const data: Uint8Array = await new USDZExporter().parseAsync(exportScene);
            if (destroyed) return;
            usdz.url = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: "model/vnd.usdz+zip" }));
            anchor.setAttribute('href', `${usdz.url}#allowsContentScaling=0`);
            anchor.removeAttribute('aria-disabled');
            anchor.textContent = label;
            anchor.appendChild(img);
          } catch {
            anchor.remove();
          }
        })();
      }
    });
  }

  // --- desenhar só quando está à vista ---------------------------------------------------------------
  let visible = true;
  const tick = (): void => {
    raf = 0;
    if (destroyed || !visible || document.hidden) return;
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  };
  const kick = (): void => {
    if (!raf && !destroyed) raf = requestAnimationFrame(tick);
  };
  io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible) kick();
  });
  io?.observe(host);
  ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { frame(); kick(); });
  ro?.observe(host);
  onVisibility = (): void => kick();
  document.addEventListener('visibilitychange', onVisibility);
  const onLost = (e: Event): void => {
    e.preventDefault();
    opts.onError?.('webgl');
  };
  canvas.addEventListener('webglcontextlost', onLost);

  host.classList.add('v3d-ready');
  kick();
  opts.onReady?.();

  function cleanup(): void {
    destroyed = true;
    if (raf) cancelAnimationFrame(raf);
    io?.disconnect();
    ro?.disconnect();
    if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
    controls.dispose();
    if (holder) disposeTree(holder);
    scene.traverse((o: Any) => {
      if (o.isMesh && o.material && o.material.map && o.material.map.isCanvasTexture) {
        o.material.map.dispose();
        o.material.dispose();
        o.geometry.dispose();
      }
    });
    envMap.dispose();
    pmrem.dispose();
    renderer.dispose();
    renderer.forceContextLoss?.();
    if (usdz.url) URL.revokeObjectURL(usdz.url);
    canvas.remove();
    ui.remove();
    host.classList.remove('v3d', 'v3d-ready');
  }

  return {
    destroy: cleanup,
    reset: resetView,
  };
}
