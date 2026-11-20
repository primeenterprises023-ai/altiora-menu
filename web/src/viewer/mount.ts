// Visualizador 3D (Three.js). Contrato usado pelo menu do cliente, pelo painel e pela página comercial.
// O motor 3D só é descarregado quando alguém toca em "Ver em 3D" (carregamento sob pedido).

export interface ViewerOptions {
  /** Endereço do ficheiro GLB (do mesmo domínio). */
  src: string;
  /** Texto alternativo (leitores de ecrã). */
  alt: string;
  /** Mostra o botão de realidade aumentada (só aparece em aparelhos que a suportam). */
  ar?: boolean;
  /** Roda sozinho até a pessoa tocar. Por omissão, sim. */
  autoRotate?: boolean;
  /** Nome do prato, para a realidade aumentada. */
  title?: string;
  /** Endereço a que voltar se a realidade aumentada não abrir. */
  fallbackUrl?: string;
  onProgress?: (fraction: number) => void;
  onReady?: () => void;
  /** 'webgl' = o aparelho não suporta 3D; 'load' = o modelo não pôde ser lido. */
  onError?: (kind: 'webgl' | 'load') => void;
}

export interface ViewerHandle {
  destroy(): void;
  /** Volta ao ponto de vista inicial. */
  reset(): void;
}

export async function mountViewer(el: HTMLElement, opts: ViewerOptions): Promise<ViewerHandle> {
  const mod = await import('./three-viewer');
  return mod.createViewer(el, opts);
}
