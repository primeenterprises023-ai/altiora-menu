// Copiar texto para a área de transferência. Em endereços seguros usa a forma moderna; senão (ou se for recusada)
// tenta o método antigo sobre um campo de texto visível. Devolve false se nenhuma funcionar, para a página avisar a pessoa.

export async function copyText(text: string, fallbackField?: HTMLInputElement | HTMLTextAreaElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // recusada (permissões, página sem foco, endereço sem HTTPS): tenta o método antigo
  }
  try {
    if (fallbackField) {
      fallbackField.focus();
      fallbackField.select();
      return document.execCommand('copy');
    }
  } catch {
    // sem mais alternativas
  }
  return false;
}

/** Descarrega um ficheiro gerado no navegador (sem o enviar para lado nenhum). */
export function saveBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 15_000);
}
