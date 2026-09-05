export interface ModelConcurrencyOptions {
  tenantId?: string;
  signal?: AbortSignal;
  waitTimeoutMs?: number;
}

interface Waiter {
  key: string;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function boundedEnvInt(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

/**
 * Process-local admission boundary shared by every model provider. The per-tenant
 * cap prevents one autonomous tenant from filling the global accelerator lane;
 * the bounded queue prevents authenticated bursts becoming an unbounded heap.
 */
export class ModelConcurrencyLimiter {
  private activeGlobal = 0;
  private readonly activeByTenant = new Map<string, number>();
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly globalLimit = boundedEnvInt('MODEL_GLOBAL_CONCURRENCY', 6, 1, 32),
    private readonly perTenantLimit = boundedEnvInt('MODEL_TENANT_CONCURRENCY', 2, 1, 8),
    private readonly maximumQueue = boundedEnvInt('MODEL_MAX_QUEUE', 64, 1, 512),
    private readonly defaultWaitTimeoutMs = boundedEnvInt('MODEL_QUEUE_TIMEOUT_MS', 10_000, 100, 60_000),
  ) {
    if (!Number.isSafeInteger(globalLimit) || globalLimit < 1) throw new Error('Invalid global model concurrency');
    if (!Number.isSafeInteger(perTenantLimit) || perTenantLimit < 1 || perTenantLimit > globalLimit) {
      throw new Error('Invalid per-tenant model concurrency');
    }
    if (!Number.isSafeInteger(maximumQueue) || maximumQueue < 1) throw new Error('Invalid model queue size');
    if (!Number.isSafeInteger(defaultWaitTimeoutMs) || defaultWaitTimeoutMs < 1) throw new Error('Invalid model queue timeout');
  }

  async withPermit<T>(options: ModelConcurrencyOptions, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(options);
    try {
      if (options.signal?.aborted) throw new Error('Model request was cancelled');
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(options: ModelConcurrencyOptions): Promise<() => void> {
    const key = this.tenantKey(options.tenantId);
    if (options.signal?.aborted) return Promise.reject(new Error('Model request was cancelled'));
    if (this.canStart(key)) {
      this.activate(key);
      return Promise.resolve(this.releaseOnce(key));
    }
    if (this.queue.length >= this.maximumQueue) {
      return Promise.reject(new Error('Model service queue is full'));
    }

    const waitTimeout = Number.isSafeInteger(options.waitTimeoutMs)
      && (options.waitTimeoutMs as number) >= 1
      && (options.waitTimeoutMs as number) <= 60_000
      ? options.waitTimeoutMs as number
      : this.defaultWaitTimeoutMs;

    return new Promise<() => void>((resolve, reject) => {
      const waiter = {} as Waiter;
      const remove = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const fail = (error: Error) => {
        remove();
        clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
        reject(error);
      };
      Object.assign(waiter, {
        key,
        resolve,
        reject,
        signal: options.signal,
        timer: setTimeout(() => fail(new Error('Model service queue wait timed out')), waitTimeout),
      });
      if (options.signal) {
        waiter.onAbort = () => fail(new Error('Model request was cancelled'));
        options.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  private tenantKey(tenantId: string | undefined): string {
    return typeof tenantId === 'string' && /^[0-9a-f-]{36}$/i.test(tenantId) ? tenantId : '__system__';
  }

  private canStart(key: string): boolean {
    return this.activeGlobal < this.globalLimit
      && (this.activeByTenant.get(key) || 0) < this.perTenantLimit;
  }

  private activate(key: string): void {
    this.activeGlobal++;
    this.activeByTenant.set(key, (this.activeByTenant.get(key) || 0) + 1);
  }

  private releaseOnce(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeGlobal = Math.max(0, this.activeGlobal - 1);
      const remaining = Math.max(0, (this.activeByTenant.get(key) || 1) - 1);
      if (remaining === 0) this.activeByTenant.delete(key);
      else this.activeByTenant.set(key, remaining);
      this.drain();
    };
  }

  private drain(): void {
    for (let index = 0; index < this.queue.length && this.activeGlobal < this.globalLimit;) {
      const waiter = this.queue[index];
      if (!this.canStart(waiter.key)) {
        index++;
        continue;
      }
      this.queue.splice(index, 1);
      clearTimeout(waiter.timer);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      this.activate(waiter.key);
      waiter.resolve(this.releaseOnce(waiter.key));
    }
  }
}

export const modelConcurrencyLimiter = new ModelConcurrencyLimiter();
