/**
 * One-at-a-time gate for anything that moves a whole project. Auto-save,
 * SAVE, OPEN, restore, and (in phase 4) import/export share it, so a poller
 * write can never interleave with a browser transfer. A failed task does not
 * poison the chain.
 */
export class OperationQueue {
  private tail: Promise<void> = Promise.resolve();
  private current: string | null = null;

  run<T>(label: string, task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      this.current = label;

      try {
        return await task();
      } finally {
        if (this.current === label) {
          this.current = null;
        }
      }
    });

    this.tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  busy(): string | null {
    return this.current;
  }
}
