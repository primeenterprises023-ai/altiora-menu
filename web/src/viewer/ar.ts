// Realidade aumentada: o que o telemóvel suporta e como a iniciar. Não depende do motor 3D (é leve).
//   Android: Google Scene Viewer (precisa de endereço https absoluto do ficheiro GLB e de ARCore: confirmado por WebXR).
//   iPhone/iPad: AR Quick Look (precisa de um ficheiro USDZ, gerado no aparelho a partir do mesmo modelo).
// Em computadores não há botão de realidade aumentada. Só se mostra o botão quando o aparelho declara suporte.
export type ArMode = 'android' | 'ios' | null;

let cached: Promise<ArMode> | null = null;

export function detectAr(): Promise<ArMode> {
  if (!cached) {
    cached = (async (): Promise<ArMode> => {
      if (typeof navigator === 'undefined' || typeof document === 'undefined') return null;
      const ua = navigator.userAgent;
      if (/android/i.test(ua)) {
        if (location.protocol !== 'https:') return null;
        const xr = (navigator as Navigator & { xr?: { isSessionSupported?: (mode: string) => Promise<boolean> } }).xr;
        try {
          return xr?.isSessionSupported && (await xr.isSessionSupported('immersive-ar')) ? 'android' : null;
        } catch {
          return null;
        }
      }
      // o iPad com iPadOS 13+ apresenta-se como um Mac com ecrã tátil
      const ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (!ios) return null;
      const probe = document.createElement('a');
      return probe.relList && typeof probe.relList.supports === 'function' && probe.relList.supports('ar') ? 'ios' : null;
    })();
  }
  return cached;
}

/** Endereço que abre o Scene Viewer no Android. O ficheiro tem de ser acessível por https. */
export function sceneViewerUrl(glb: string, title: string, fallback: string): string {
  const file = new URL(glb, location.href).href;
  const params = `file=${encodeURIComponent(file)}&mode=ar_preferred&title=${encodeURIComponent(title)}&link=${encodeURIComponent(fallback)}`;
  return `intent://arvr.google.com/scene-viewer/1.0?${params}#Intent;scheme=https;package=com.google.android.googlequicksearchbox;action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(fallback)};end;`;
}

/** Só para testes: esquece o resultado guardado. */
export const resetArDetection = (): void => {
  cached = null;
};
