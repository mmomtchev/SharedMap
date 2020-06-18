declare module 'sharedmap' {
    class Deadlock extends Error {};

    interface SharedMapOptions {
        lockWrite: boolean;
        lockExclusive: boolean;
    }

    export class SharedMap {
        constructor(maxSize: number, keySize: number, objSize: number);
        
        get length(): number;
        get size(): number;

        lockExclusive(): void;
        unlockExclusive(): void;
        lockWrite(): void;
        unlockWrite(): void;

        set(key: string, value: string | number, options: SharedMapOptions): void;
        get(key: string, options: SharedMapOptions): string?;

        has(key: string, options: SharedMapOptions): boolean;
        delete(key: string, options: SharedMapOptions): void;
        clear(): void;

        *keys(options: SharedMapOptions): Iterable<string>;
        
        map(cb: (currentValue: string, key?: string) => T, thisArg: unknown): T[];
        reduce(cb: (accumulator: T, currentValue: string, key: string) => T, initialValue: T);
    }
}
