// Contador de tentativas falhas por chave (IP, operador), com janela fixa e
// limite de chaves em memória para não crescer sem fim.
export class AttemptLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly max: number, private readonly windowMs: number, private readonly maxKeys = 5_000) {}

  blocked(key: string, now = Date.now()) {
    const current = this.attempts.get(key);
    return Boolean(current && current.resetAt > now && current.count >= this.max);
  }

  fail(key: string, now = Date.now()) {
    const current = this.attempts.get(key);
    const active = current && current.resetAt > now ? current : { count: 0, resetAt: now + this.windowMs };
    active.count += 1;
    this.attempts.delete(key);
    this.attempts.set(key, active);
    if (this.attempts.size > this.maxKeys) {
      for (const [entry, value] of this.attempts) {
        if (value.resetAt <= now || this.attempts.size > this.maxKeys) this.attempts.delete(entry);
        if (this.attempts.size <= this.maxKeys) break;
      }
    }
  }

  reset(key: string) {
    this.attempts.delete(key);
  }
}
