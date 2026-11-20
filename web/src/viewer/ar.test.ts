// Lógica da realidade aumentada (sem aparelho real): o botão só aparece quando o telemóvel declara suporte, e o endereço do Scene Viewer está certo.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { detectAr, resetArDetection, sceneViewerUrl } from './ar';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;
const saved: G = {};
const KEYS = ['navigator', 'document', 'location'];

interface Env {
  ua: string;
  protocol?: string;
  xr?: unknown;
  platform?: string;
  touch?: number;
  arRel?: boolean;
}

function setEnv(e: Env): void {
  g.navigator = { userAgent: e.ua, platform: e.platform ?? 'Linux armv8l', maxTouchPoints: e.touch ?? 5, xr: e.xr };
  g.location = { protocol: e.protocol ?? 'https:', href: 'https://menu.altiora.test/r/casa-aurora' };
  g.document = { createElement: () => ({ relList: { supports: (t: string) => t === 'ar' && e.arRel === true } }) };
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = g[k];
  resetArDetection();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
  resetArDetection();
});

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const xr = (supported: boolean) => ({ isSessionSupported: async (mode: string) => mode === 'immersive-ar' && supported });

describe('detectAr', () => {
  test('Android com https e WebXR a declarar realidade aumentada → "android"', async () => {
    setEnv({ ua: ANDROID, xr: xr(true) });
    expect(await detectAr()).toBe('android');
  });

  test('Android sem suporte, sem WebXR, com erro ou em http → sem botão', async () => {
    setEnv({ ua: ANDROID, xr: xr(false) });
    expect(await detectAr()).toBeNull();
    resetArDetection();
    setEnv({ ua: ANDROID });
    expect(await detectAr()).toBeNull();
    resetArDetection();
    setEnv({ ua: ANDROID, xr: { isSessionSupported: async () => { throw new Error('boom'); } } });
    expect(await detectAr()).toBeNull();
    resetArDetection();
    setEnv({ ua: ANDROID, xr: xr(true), protocol: 'http:' });
    expect(await detectAr()).toBeNull();
  });

  test('iPhone cujo Safari reconhece rel="ar" → "ios"; sem esse suporte → sem botão', async () => {
    setEnv({ ua: IPHONE, platform: 'iPhone', arRel: true });
    expect(await detectAr()).toBe('ios');
    resetArDetection();
    setEnv({ ua: IPHONE, platform: 'iPhone', arRel: false });
    expect(await detectAr()).toBeNull();
  });

  test('iPad que se apresenta como Mac com ecrã tátil também conta', async () => {
    setEnv({ ua: DESKTOP.replace('Windows NT 10.0; Win64; x64', 'Macintosh; Intel Mac OS X 10_15_7'), platform: 'MacIntel', touch: 5, arRel: true });
    expect(await detectAr()).toBe('ios');
    resetArDetection();
    setEnv({ ua: DESKTOP.replace('Windows NT 10.0; Win64; x64', 'Macintosh; Intel Mac OS X 10_15_7'), platform: 'MacIntel', touch: 0, arRel: true });
    expect(await detectAr()).toBeNull(); // um Mac a sério, sem ecrã tátil
  });

  test('computadores nunca têm o botão', async () => {
    setEnv({ ua: DESKTOP, platform: 'Win32', touch: 0, xr: xr(true), arRel: true });
    expect(await detectAr()).toBeNull();
  });

  test('o resultado é guardado (a verificação só corre uma vez)', async () => {
    let calls = 0;
    setEnv({ ua: ANDROID, xr: { isSessionSupported: async () => { calls++; return true; } } });
    await detectAr();
    await detectAr();
    expect(calls).toBe(1);
  });
});

describe('sceneViewerUrl', () => {
  test('o ficheiro vira um endereço absoluto e o título e o regresso vão codificados', () => {
    setEnv({ ua: ANDROID });
    const url = sceneViewerUrl('/a/0b7c2d1e-0000-4000-8000-000000000001', 'Muamba & Funge "da casa"', 'https://menu.altiora.test/r/casa-aurora?mesa=3');
    expect(url.startsWith('intent://arvr.google.com/scene-viewer/1.0?')).toBe(true);
    expect(url).toContain(`file=${encodeURIComponent('https://menu.altiora.test/a/0b7c2d1e-0000-4000-8000-000000000001')}`);
    expect(url).toContain('mode=ar_preferred');
    expect(url).toContain(`title=${encodeURIComponent('Muamba & Funge "da casa"')}`);
    expect(url).toContain(`link=${encodeURIComponent('https://menu.altiora.test/r/casa-aurora?mesa=3')}`);
    expect(url).toContain('#Intent;scheme=https;package=com.google.android.googlequicksearchbox;action=android.intent.action.VIEW;');
    expect(url).toContain(`S.browser_fallback_url=${encodeURIComponent('https://menu.altiora.test/r/casa-aurora?mesa=3')};end;`);
    // nada do que veio do restaurante pode "fechar" o endereço: sem espaços, aspas nem ";" soltos antes do "#Intent"
    expect(url.split('#Intent')[0]).not.toMatch(/[\s";]/);
  });
});
