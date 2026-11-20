// Recipiente React do visualizador 3D: mostra a fotografia enquanto o modelo carrega e, se o 3D não for possível, só a fotografia.
import { useEffect, useRef, useState } from 'react';
import { mountViewer, type ViewerHandle } from './mount';

interface Props {
  src: string;
  alt: string;
  poster?: string | null;
  ar?: boolean;
  title?: string;
  fallbackUrl?: string;
  autoRotate?: boolean;
  className?: string;
  /** Avisa quem chamou quando o 3D não é possível (para voltar à fotografia). */
  onUnavailable?: () => void;
}

export function ViewerPanel({ src, alt, poster, ar, title, fallbackUrl, autoRotate, className = '', onUnavailable }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'webgl' | 'load'>('loading');
  const [progress, setProgress] = useState(0);
  const unavailableRef = useRef(onUnavailable);
  unavailableRef.current = onUnavailable;

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let dead = false;
    let handle: ViewerHandle | null = null;
    setState('loading');
    setProgress(0);
    mountViewer(node, {
      src, alt, ar, title, fallbackUrl, autoRotate,
      onProgress: (f) => !dead && setProgress(f),
      onReady: () => !dead && setState('ready'),
      onError: (kind) => {
        if (dead) return;
        setState(kind);
        unavailableRef.current?.();
      },
    })
      .then((h) => {
        if (dead) h.destroy();
        else handle = h;
      })
      .catch(() => {
        if (dead) return;
        setState('load');
        unavailableRef.current?.();
      });
    return () => {
      dead = true;
      handle?.destroy();
    };
  }, [src, alt, ar, title, fallbackUrl, autoRotate]);

  const failed = state === 'webgl' || state === 'load';
  return (
    <div className={`v3d-wrap ${className}`}>
      {poster && state !== 'ready' ? <img className="v3d-poster" src={poster} alt={failed ? alt : ''} decoding="async" /> : null}
      <div ref={host} className="v3d-host" hidden={failed} />
      {state === 'loading' ? (
        <p className="v3d-status" role="status">
          A carregar o modelo 3D{progress > 0 ? ` · ${Math.round(progress * 100)} %` : '…'}
        </p>
      ) : null}
      {failed ? (
        <p className="v3d-status v3d-status-error" role="status">
          {state === 'webgl' ? 'Este aparelho não consegue mostrar o 3D.' : 'Não foi possível abrir o modelo 3D.'} Veja a fotografia.
        </p>
      ) : null}
    </div>
  );
}
