// Aviso sonoro (dois toques curtos) feito pelo próprio navegador: não precisa de ficheiros de som.
// Os navegadores só deixam tocar som depois de a pessoa tocar no ecrã uma vez; por isso o som liga-se com um botão.
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Chamar a partir de um toque/clique. Devolve true se o som ficou pronto a tocar. */
export async function unlockSound(): Promise<boolean> {
  const c = audio();
  if (!c) return false;
  try {
    await c.resume();
  } catch {
    /* ignora */
  }
  return c.state === 'running';
}

export function soundReady(): boolean {
  return !!ctx && ctx.state === 'running';
}

/** Toca o aviso. Devolve false se o navegador não deixou (ainda) tocar. */
export function chime(): boolean {
  const c = audio();
  if (!c) return false;
  if (c.state !== 'running') {
    void c.resume().catch(() => undefined);
    return false;
  }
  const start = c.currentTime + 0.02;
  for (const [freq, delay, length] of [
    [880, 0, 0.16],
    [1174.66, 0.18, 0.28],
  ] as const) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start + delay);
    gain.gain.exponentialRampToValueAtTime(0.28, start + delay + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + length);
    osc.connect(gain).connect(c.destination);
    osc.start(start + delay);
    osc.stop(start + delay + length + 0.05);
  }
  return true;
}
