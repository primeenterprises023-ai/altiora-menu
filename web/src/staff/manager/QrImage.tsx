// QR Code desenhado como imagem vetorial (SVG) diretamente em React: sem bibliotecas e sem HTML inserido à mão.
// O fundo é sempre branco e os módulos sempre pretos, mesmo no modo escuro: é assim que os leitores de telemóvel funcionam melhor.
import { useMemo } from 'react';
import { encodeQr, qrPath, qrSvg } from '../../../../shared/qr';

/** Nível de correção "Q": aguenta cerca de 25% de dano (papel sujo, dobras), importante para QR Codes colados em mesas. */
const ECC = 'Q' as const;
const QUIET = 4;

const cache = new Map<string, { d: string; side: number }>();

function pathFor(url: string): { d: string; side: number } {
  const hit = cache.get(url);
  if (hit) return hit;
  const made = qrPath(encodeQr(url, ECC), QUIET);
  if (cache.size > 300) cache.clear();
  cache.set(url, made);
  return made;
}

interface Props {
  url: string;
  /** Texto para leitores de ecrã (ignorado se for só decorativo). */
  label: string;
  /** Quando o QR Code está dentro de um botão que já tem o seu próprio nome. */
  decorative?: boolean;
  className?: string;
}

export function QrImage({ url, label, decorative, className }: Props) {
  const { d, side } = useMemo(() => pathFor(url), [url]);
  return (
    <svg
      className={className}
      viewBox={`0 0 ${side} ${side}`}
      shapeRendering="crispEdges"
      {...(decorative ? { 'aria-hidden': true, focusable: false } : { role: 'img', 'aria-label': label })}
    >
      <rect width={side} height={side} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}

/** O mesmo QR Code como ficheiro SVG (texto), para guardar e imprimir em qualquer tamanho. */
export function qrSvgFile(url: string): string {
  return qrSvg(encodeQr(url, ECC), { quiet: QUIET });
}

/** O mesmo QR Code como imagem PNG (cada módulo com um número inteiro de pixéis, para ficar nítido). */
export function qrPngBlob(url: string, targetPx = 1000): Promise<Blob> {
  const qr = encodeQr(url, ECC);
  const side = qr.size + QUIET * 2;
  const scale = Math.max(2, Math.floor(targetPx / side));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = side * scale;
  const g = canvas.getContext('2d');
  if (!g) return Promise.reject(new Error('Este navegador não consegue criar a imagem.'));
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#000000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.isDark(x, y)) g.fillRect((x + QUIET) * scale, (y + QUIET) * scale, scale, scale);
    }
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Não foi possível criar a imagem.'))), 'image/png');
  });
}
