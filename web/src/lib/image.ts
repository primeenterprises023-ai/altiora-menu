// Prepara fotografias no telemóvel antes de as enviar: corrige a orientação, reduz o tamanho e comprime.
// Assim uma fotografia de 6 MB tirada com a câmara passa a ter algumas centenas de KB e o envio é rápido, mesmo com dados móveis.

export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageError';
  }
}

export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';
/** Limite de envio de ficheiros antes de qualquer redução (a fotografia é reduzida no aparelho, por isso é largo). */
export const MAX_PICK_BYTES = 25 * 1024 * 1024;

export interface PrepareOptions {
  /** Maior lado da imagem final, em pixéis. */
  maxEdge: number;
  /** Tamanho máximo do ficheiro final, em bytes. */
  maxBytes: number;
  /** Recorta ao centro com esta proporção (largura / altura) — para miniaturas. */
  ratio?: number;
  /** Mantém a transparência (logótipos): guarda em WebP ou PNG em vez de JPEG. */
  alpha?: boolean;
}

export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* tenta com um elemento <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new ImageError('Não foi possível abrir esta imagem. Use uma fotografia JPEG, PNG ou WebP.');
  }
}

const encode = (canvas: HTMLCanvasElement, type: string, quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/** Dimensões finais e zona de origem a usar (recorte ao centro se houver proporção). */
export function planImage(srcW: number, srcH: number, opts: Pick<PrepareOptions, 'maxEdge' | 'ratio'>): { sx: number; sy: number; sw: number; sh: number; w: number; h: number } {
  let sx = 0;
  let sy = 0;
  let sw = srcW;
  let sh = srcH;
  if (opts.ratio && opts.ratio > 0) {
    if (srcW / srcH > opts.ratio) {
      sw = Math.round(srcH * opts.ratio);
      sx = Math.round((srcW - sw) / 2);
    } else {
      sh = Math.round(srcW / opts.ratio);
      sy = Math.round((srcH - sh) / 2);
    }
  }
  const scale = Math.min(1, opts.maxEdge / Math.max(sw, sh));
  return { sx, sy, sw, sh, w: Math.max(1, Math.round(sw * scale)), h: Math.max(1, Math.round(sh * scale)) };
}

/**
 * Lê a imagem escolhida e devolve uma versão reduzida e comprimida que cabe em `maxBytes`.
 * Recusa ficheiros que não são imagens (o servidor volta a conferir o conteúdo real do ficheiro).
 */
export async function prepareImage(file: Blob, opts: PrepareOptions): Promise<PreparedImage> {
  if (file.size > MAX_PICK_BYTES) throw new ImageError('Este ficheiro é demasiado grande. Escolha uma fotografia mais pequena.');
  if (file.type && !/^image\/(jpeg|png|webp)$/i.test(file.type)) throw new ImageError('Use uma fotografia JPEG, PNG ou WebP.');
  const img = await decode(file);
  try {
    const plan = planImage(img.width, img.height, opts);
    let factor = 1;
    for (let round = 0; round < 6; round++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(plan.w * factor));
      canvas.height = Math.max(1, Math.round(plan.h * factor));
      const g = canvas.getContext('2d');
      if (!g) throw new ImageError('Este aparelho não consegue preparar a imagem. Tente noutro aparelho.');
      if (!opts.alpha) {
        g.fillStyle = '#ffffff'; // JPEG não tem transparência: o fundo transparente ficaria preto
        g.fillRect(0, 0, canvas.width, canvas.height);
      }
      g.imageSmoothingQuality = 'high';
      g.drawImage(img.source, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, canvas.width, canvas.height);
      for (const q of [0.86, 0.76, 0.66, 0.55]) {
        const blob = await encode(canvas, opts.alpha ? 'image/webp' : 'image/jpeg', q);
        if (!blob) throw new ImageError('Não foi possível preparar a imagem.');
        if (blob.size <= opts.maxBytes) return { blob, width: canvas.width, height: canvas.height };
        if (blob.type === 'image/png') break; // sem controlo de qualidade (aparelhos sem WebP): só ajuda reduzir o tamanho
      }
      factor *= 0.8;
    }
    throw new ImageError('Esta imagem continua demasiado pesada. Escolha outra, mais simples ou mais pequena.');
  } finally {
    img.close();
  }
}

/** Presets usados pelo painel do gerente. */
export const PHOTO: PrepareOptions = { maxEdge: 1600, maxBytes: 1_800_000 };
export const THUMB: PrepareOptions = { maxEdge: 480, maxBytes: 120_000, ratio: 4 / 3 };
export const LOGO: PrepareOptions = { maxEdge: 512, maxBytes: 400_000, alpha: true };
export const COVER: PrepareOptions = { maxEdge: 1600, maxBytes: 1_800_000, ratio: 16 / 9 };
