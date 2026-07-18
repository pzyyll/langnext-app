// ABOUTME: Ordered theme persistence queue independent of React rendering.
// ABOUTME: Guarantees backend invocation order matches user click order.
export type ThemeMode = "light" | "dark";

export type ThemePersistFn = (mode: ThemeMode) => Promise<void>;

export interface ThemeMutationQueueOptions {
  persist: ThemePersistFn;
  onSuccess?: (mode: ThemeMode, mutationId: number) => void;
  onFailure?: (mode: ThemeMode, mutationId: number, error: unknown) => void;
}

/**
 * Chains backend writes so each settles before the next begins.
 * Mutation IDs increase monotonically for stale-failure suppression.
 */
export class ThemeMutationQueue {
  private chain: Promise<void> = Promise.resolve();
  private nextId = 0;
  private latestId = 0;
  private readonly persist: ThemePersistFn;
  private readonly onSuccess?: ThemeMutationQueueOptions["onSuccess"];
  private readonly onFailure?: ThemeMutationQueueOptions["onFailure"];

  constructor(options: ThemeMutationQueueOptions) {
    this.persist = options.persist;
    this.onSuccess = options.onSuccess;
    this.onFailure = options.onFailure;
  }

  /** Latest mutation id visible to the UI (including in-flight). */
  get latestMutationId(): number {
    return this.latestId;
  }

  /**
   * Enqueue a theme write. Returns the mutation id for this request.
   * Backend calls run strictly in enqueue order.
   */
  enqueue(mode: ThemeMode): number {
    const mutationId = ++this.nextId;
    this.latestId = mutationId;

    this.chain = this.chain.then(async () => {
      try {
        await this.persist(mode);
        this.onSuccess?.(mode, mutationId);
      } catch (error) {
        this.onFailure?.(mode, mutationId, error);
      }
    });

    return mutationId;
  }

  /** Wait until all currently enqueued mutations settle. */
  async drain(): Promise<void> {
    await this.chain;
  }
}
