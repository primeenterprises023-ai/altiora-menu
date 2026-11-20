// Descarregar um ficheiro (PDF) do servidor com a sessão atual; os erros (plano, permissões) aparecem como mensagem, não como ficheiro estragado.
import { ApiError } from '../lib/api';

export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Sem ligação ao servidor. Verifique a internet e tente novamente.');
  }
  if (!res.ok) {
    let message = 'Não foi possível descarregar o ficheiro.';
    let code = `HTTP_${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      /* resposta sem JSON */
    }
    throw new ApiError(res.status, code, message);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
