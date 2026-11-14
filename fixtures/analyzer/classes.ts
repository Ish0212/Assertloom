export class Counter {
  private count: number;

  constructor(initial = 0) {
    this.count = initial;
  }

  increment(by = 1): number {
    this.count += by;
    return this.count;
  }

  decrement(by = 1): number {
    this.count -= by;
    return this.count;
  }

  reset(): void {
    this.count = 0;
  }

  async incrementLater(by = 1): Promise<number> {
    return this.increment(by);
  }

  divide(by: number): number {
    if (by === 0) throw new Error("Cannot divide by zero");
    return this.count / by;
  }

  static from(start: number): Counter {
    return new Counter(start);
  }

  get value(): number {
    return this.count;
  }

  #secret(): number {
    return 42;
  }

  private helper(): number {
    return this.count;
  }
}

export class Box<T> {
  constructor(private item: T) {}

  get(): T {
    return this.item;
  }

  set(item: T): void {
    this.item = item;
  }
}

class Internal {
  ping(): string {
    return "pong";
  }
}

export default class Registry {
  private entries = new Map<string, number>();

  register(name: string, value: number): void {
    this.entries.set(name, value);
  }

  lookup(name: string): number | undefined {
    return this.entries.get(name);
  }
}

export function total(a: number, b: number): number {
  return a + b;
}
