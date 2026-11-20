// Limita quantas tarefas pesadas correm em simultâneo (ex.: cálculo de palavras-passe, que usa muita memória).

export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next(); // passa a vaga diretamente ao próximo
      else this.active--;
    }
  }

  get waiting(): number {
    return this.queue.length;
  }
}
