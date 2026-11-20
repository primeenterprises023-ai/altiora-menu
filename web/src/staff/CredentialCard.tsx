// Cartão com os dados de acesso de uma conta nova (ou com palavra-passe reposta). A palavra-passe temporária só existe
// neste momento: o servidor guarda apenas uma versão cifrada, por isso depois de fechar já não há como a voltar a ver.
import { useRef } from 'react';
import { copyText } from '../lib/clipboard';
import { Button } from '../ui/Button';
import { useToast } from '../ui/Toast';

interface Props {
  /** "nova": conta acabada de criar; "reposta": palavra-passe reposta. */
  kind: 'nova' | 'reposta';
  name: string;
  email: string;
  password: string;
  /** Nome do restaurante (ou da plataforma), para a mensagem pronta. */
  place: string;
  loginUrl: string;
}

export function CredentialCard({ kind, name, email, password, place, loginUrl }: Props) {
  const toast = useToast();
  const field = useRef<HTMLInputElement>(null);
  const message = [
    kind === 'nova' ? `Olá, ${name}! Já tem acesso ao painel de ${place}.` : `Olá, ${name}! A sua palavra-passe de acesso ao painel de ${place} foi reposta.`,
    `Endereço: ${loginUrl}`,
    `E-mail: ${email}`,
    `Palavra-passe temporária: ${password}`,
    'No primeiro acesso vai escolher uma palavra-passe nova, só sua.',
  ].join('\n');

  const copy = async (text: string, done: string, fallback?: HTMLInputElement | null) => {
    const ok = await copyText(text, fallback);
    toast.show(ok ? done : 'Não foi possível copiar. Toque na palavra-passe, selecione-a e copie.', ok ? 'info' : 'danger');
  };

  return (
    <div className="stack-lg cred">
      <p className="notice">
        <strong>Estes dados só aparecem agora.</strong> A palavra-passe é temporária e de uso único: no primeiro acesso, {name} escolhe uma nova. Se a perder, pode repor outra.
      </p>
      <dl className="cred-rows">
        <div>
          <dt>Endereço de entrada</dt>
          <dd>{loginUrl}</dd>
        </div>
        <div>
          <dt>E-mail</dt>
          <dd>{email}</dd>
        </div>
      </dl>
      <div className="field">
        <label className="label" htmlFor="cred-password">
          Palavra-passe temporária
        </label>
        <input
          id="cred-password"
          ref={field}
          className="input cred-password"
          readOnly
          value={password}
          autoComplete="off"
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
        />
      </div>
      <div className="btn-pair">
        <Button variant="secondary" onClick={() => void copy(password, 'Palavra-passe copiada.', field.current)}>
          Copiar palavra-passe
        </Button>
        <Button variant="secondary" onClick={() => void copy(message, 'Mensagem copiada.')}>
          Copiar mensagem pronta
        </Button>
      </div>
      <p className="muted small">A mensagem pronta leva o endereço, o e-mail e a palavra-passe: cole-a numa conversa privada (por exemplo, WhatsApp) com a pessoa.</p>
    </div>
  );
}
