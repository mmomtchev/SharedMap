'use strict';
const UINT32_MAX = 0xFFFFFFFF;
const UINT32_UNDEFINED = 0xFFFFFFFF;

/**
 * This is MurmurHash2
 * @private
 * @param {string}
 * @return {number}
 */
function _hash(str) {
    var
        l = str.length,
        h = 17 ^ l,
        i = 0,
        k;
    while (l >= 4) {
        k =
            ((str.charCodeAt(i) & 0xff)) |
            ((str.charCodeAt(++i) & 0xff) << 8) |
            ((str.charCodeAt(++i) & 0xff) << 16) |
            ((str.charCodeAt(++i) & 0xff) << 14);
        k = (((k & 0xffff) * 0x5bd1e995) + ((((k >>> 16) * 0x5bd1e995) & 0xffff) << 16));
        k ^= k >>> 14;
        k = (((k & 0xffff) * 0x5bd1e995) + ((((k >>> 16) * 0x5bd1e995) & 0xffff) << 16));
        h = (((h & 0xffff) * 0x5bd1e995) + ((((h >>> 16) * 0x5bd1e995) & 0xffff) << 16)) ^ k;
        l -= 4;
        ++i;
    }
    /* eslint-disable no-fallthrough */
    switch (l) {
        case 3: h ^= (str.charCodeAt(i + 2) & 0xff) << 16;
        case 2: h ^= (str.charCodeAt(i + 1) & 0xff) << 8;
        case 1: h ^= (str.charCodeAt(i) & 0xff);
            h = (((h & 0xffff) * 0x5bd1e995) + ((((h >>> 16) * 0x5bd1e995) & 0xffff) << 16));
    }
    /* eslint-enable no-fallthrough */
    h ^= h >>> 13;
    h = (((h & 0xffff) * 0x5bd1e995) + ((((h >>> 16) * 0x5bd1e995) & 0xffff) << 16));
    h ^= h >>> 15;
    return h >>> 0;
}

function align32(v) {
    return (v & 0xFFFFFFFFFFFFC) + ((v & 0x3) ? 0x4 : 0);
}

const META = {
    maxSize: 0,
    keySize: 1,
    objSize: 2,
    length: 3
};

const LOCK = {
    SHAREDREAD: 0,
    READLOCK: 1,
    READERS: 2,
    SHAREDWRITE: 3,
    WRITELOCK: 4,
    WRITERS: 5
};

class Deadlock extends Error {
    constructor(...params) {
        super(...params);
    }
}

/**
 * SharedMap
 * 
 * zero-dependency
 * high-performance
 * unordered
 * Vanilla JS implementation of SharedMap,
 * a synchronous multi-threading capable,
 * fine-grain-locked with deadlock recovery,
 * static memory allocated,
 * coalesced-chaining HashMap,
 * backed by SharedArrayBuffer
 * that supports deleting
 * and is capable of auto-defragmenting itself on delete unless almost full
 * compatible with both Node.js and SharedArrayBuffer-enabled browsers
 * @author Momtchil Momtchev <momtchil@momtchev.com>
 * @see http://github.com/mmomtchev/SharedMap
 */
class SharedMap {
    /**
     * Creates a new SharedMap
     * @param {number} maxSize - Maximum number of entries
     * @param {number} keySize - Maximum length of keys in UTF-16 codepoints
     * @param {number} objSize - Maximum length of values in UTF-16 codepoints
     * @return {SharedMap}
     */
    constructor(maxSize, keySize, objSize) {
        maxSize = align32(maxSize);
        keySize = align32(keySize);
        objSize = align32(objSize);

        if (!(maxSize > 0 && keySize > 0 && objSize > 0))
            throw new RangeError('maxSize, keySize and objSize must be positive numbers');
        this.storage = new SharedArrayBuffer(
            Object.keys(META).length * Uint32Array.BYTES_PER_ELEMENT
            + (keySize + objSize) * maxSize * Uint16Array.BYTES_PER_ELEMENT
            + maxSize * Uint32Array.BYTES_PER_ELEMENT
            + Math.ceil(maxSize / 32) * Int32Array.BYTES_PER_ELEMENT
            + Object.keys(LOCK).length * Int32Array.BYTES_PER_ELEMENT);

        let offset = 0;
        this.meta = new Uint32Array(this.storage, offset, Object.keys(META).length);
        offset += this.meta.byteLength;
        this.meta[META.maxSize] = maxSize;
        this.meta[META.keySize] = keySize;
        this.meta[META.objSize] = objSize;
        this.meta[META.length] = 0;
        this.keysData = new Uint16Array(this.storage, offset, this.meta[META.keySize] * this.meta[META.maxSize]);
        offset += this.keysData.byteLength;
        this.valuesData = new Uint16Array(this.storage, offset, this.meta[META.objSize] * this.meta[META.maxSize]);
        offset += this.valuesData.byteLength;
        this.chaining = new Uint32Array(this.storage, offset, this.meta[META.maxSize]);
        offset += this.chaining.byteLength;
        this.linelocks = new Int32Array(this.storage, offset, Math.ceil(maxSize / 32));
        offset += this.linelocks.byteLength;
        this.maplock = new Int32Array(this.storage, offset, Object.keys(LOCK).length);
        this.stats = { set: 0, delete: 0, collisions: 0, rechains: 0, get: 0, deadlock: 0 };
    }

    /**
     * Number of elements present
     * @return {number}
     */
    get length() {
        /* We do not hold a lock here */
        return Atomics.load(this.meta, META.length);
    }

    /**
     * Maximum number of elements allowed
     * @return {number}
     */
    get size() {
        return this.meta[META.maxSize];
    }

    /* eslint-disable no-constant-condition */
    /**
     * @private
     */
    _lock(l) {
        while (true) {
            let state;
            state = Atomics.exchange(this.maplock, l, 1);
            if (state == 0)
                return;
            Atomics.wait(this.maplock, l, state);
        }
    }

    /**
     * @private
     */
    _unlock(l) {
        const state = Atomics.exchange(this.maplock, l, 0);
        if (state == 0)
            throw new Error('maplock desync ' + l);
        Atomics.notify(this.maplock, l);
    }

    /**
     * @private
     */
    _lockLine(pos) {
        const bitmask = 1 << (pos % 32);
        const index = Math.floor(pos / 32);
        while (true) {
            const state = Atomics.or(this.linelocks, index, bitmask);
            if ((state & bitmask) == 0)
                return pos;
            Atomics.wait(this.linelocks, index, state);
        }
    }
    /* eslint-enable no-constant-condition */

    /**
     * @private
     */
    _unlockLine(pos) {
        const bitmask = 1 << (pos % 32);
        const notbitmask = (~bitmask) & UINT32_MAX;
        const index = Math.floor(pos / 32);
        const state = Atomics.and(this.linelocks, index, notbitmask);
        if ((state & bitmask) == 0)
            throw new Error('linelock desync ' + pos);
        Atomics.notify(this.linelocks, index);
    }

    /**
     * @private
     */
    _lockLineSliding(oldLock, newLock) {
        if (newLock <= oldLock)
            throw new Deadlock();
        this._lockLine(newLock);
        this._unlockLine(oldLock);
        return newLock;
    }

    /**
     * Acquire an exclusive lock,
     * All operations that need it, automatically acquire it,
     * Use only if you need to block all other threads from accessing the map;
     * The thread holding the lock can then call map.set(k, v, {lockHeld: true})
     * @return {void}
     */
    lockExclusive() {
        this._lock(LOCK.READLOCK);
    }

    /**
     * Release the exclusive lock
     * @return {void}
     */
    unlockExclusive() {
        this._unlock(LOCK.READLOCK);
    }

    /**
     * @private
     */
    _lockSharedRead() {
        this._lock(LOCK.SHAREDREAD);
        if (++this.maplock[LOCK.READERS] == 1)
            this._lock(LOCK.READLOCK);
        this._unlock(LOCK.SHAREDREAD);
    }

    /**
     * @private
     */
    _unlockSharedRead() {
        this._lock(LOCK.SHAREDREAD);
        if (--this.maplock[LOCK.READERS] == 0)
            this._unlock(LOCK.READLOCK);
        this._unlock(LOCK.SHAREDREAD);
    }

    /**
     * @private
     */
    _lockSharedWrite() {
        this._lockSharedRead();
        this._lock(LOCK.SHAREDWRITE);
        if (++this.maplock[LOCK.WRITERS] == 1)
            this._lock(LOCK.WRITELOCK);
        this._unlock(LOCK.SHAREDWRITE);
    }

     /**
     * @private
     */
   _unlockSharedWrite() {
        this._lock(LOCK.SHAREDWRITE);
        if (--this.maplock[LOCK.WRITERS] == 0)
            this._unlock(LOCK.WRITELOCK);
        this._unlock(LOCK.SHAREDWRITE);
        this._unlockSharedRead();
    }

    /**
     * Acquire a write lock,
     * All operations that need it, automatically acquire it,
     * Use only if you need to block all other threads from writing to the map,
     * The thread holding the lock can then call map.set(k, v, {lockHeld: true})
     * @example
     * myMap.lockWrite();
     * for (let k of myMap.keys({lockWrite: true}))
     *   myMap.set(k,
     *     myMap.get(k, {lockWrite: true}).toUpperCase(),
     *     {lockWrite: true});
     * myMap.unlockWrite();
     * @return {void}
     */
    lockWrite() {
        this._lockSharedRead();
        this._lock(LOCK.WRITELOCK);
    }

    /**
     * Release the write lock
     * @return {void}
     */
    unlockWrite() {
        this._unlock(LOCK.WRITELOCK);
        this._unlockSharedRead();
    }

    /**
     * @private
     */
    _match(key, pos) {
        let i;
        for (i = 0; i < key.length; i++)
            if (this.keysData[pos * this.meta[META.keySize] + i] !== key.charCodeAt(i))
                break;
        return i === key.length && this.keysData[pos * this.meta[META.keySize] + i] === 0;
    }

    /**
     * @private
     */
    _decodeValue(pos) {
        const eos = this.valuesData.subarray(pos * this.meta[META.objSize], (pos + 1) * this.meta[META.objSize]).findIndex(x => x === 0);
        const end = eos < 0 ? (pos + 1) * this.meta[META.objSize] : pos * this.meta[META.objSize] + eos;
        return String.fromCharCode.apply(null, this.valuesData.subarray(pos * this.meta[META.objSize], end));
    }

    /**
     * @private
     */
    _decodeKey(pos) {
        const eos = this.keysData.subarray(pos * this.meta[META.keySize], (pos + 1) * this.meta[META.keySize]).findIndex(x => x === 0);
        const end = eos < 0 ? (pos + 1) * this.meta[META.keySize] : pos * this.meta[META.keySize] + eos;
        return String.fromCharCode.apply(null, this.keysData.subarray(pos * this.meta[META.keySize], end));
    }

    /**
     * These two are debugging aids
     * @private
     */
    /* c8 ignore next 8 */
    _decodeBucket(pos, n) {
        return `pos: ${pos}`
            + ` hash: ${this._hash(this._decodeKey(pos))}`
            + ` key: ${this._decodeKey(pos)}`
            + ` value: ${this._decodeValue(pos)}`
            + ` chain: ${this.chaining[pos]}`
            + ((n > 0 && this.chaining[pos] !== UINT32_UNDEFINED) ? '\n' + (this._decodeBucket(this.chaining[pos], n - 1)) : '');
    }
    /**
     * @private
     */
    /* c8 ignore next 5 */
    __printMap() {
        for (let i = 0; i < this.meta[META.maxSize]; i++)
            console.log(this._decodeBucket(i, 0));
        process.exit(1);
    }

    /**
     * @private
     */
    _write(pos, key, value) {
        let i;
        for (i = 0; i < key.length; i++)
            this.keysData[pos * this.meta[META.keySize] + i] = key.charCodeAt(i);
        this.keysData[pos * this.meta[META.keySize] + i] = 0;
        for (i = 0; i < value.length; i++)
            this.valuesData[pos * this.meta[META.objSize] + i] = value.charCodeAt(i);
        this.valuesData[pos * this.meta[META.objSize] + i] = 0;
    }

    /**
     * @private
     */
    _set(key, value, exclusive) {
        /* Hash */
        let pos = this._hash(key);
        /* Check for full table condition */
        if (Atomics.load(this.meta, META.length) === this.meta[META.maxSize])
            if (!this._find(key, exclusive))
                throw new RangeError('SharedMap is full');
        /* Find the first free bucket, remembering the last occupied one to chain it */
        let toChain;
        let slidingLock;
        exclusive || (slidingLock = this._lockLine(pos, exclusive));
        try {
            while (this.keysData[pos * this.meta[META.keySize]] !== 0) {
                this.stats.collisions++;
                /* Replacing existing key */
                if (this._match(key, pos)) {
                    for (let i = 0; i < value.length; i++)
                        this.valuesData[pos * this.meta[META.objSize] + i] = value.charCodeAt(i);
                    exclusive || this._unlockLine(slidingLock);
                    return;
                }
                if (this.chaining[pos] === UINT32_UNDEFINED || toChain !== undefined) {
                    /* This is the last collision element, we will chain ourselves to it */
                    if (toChain == undefined) {
                        toChain = pos;
                        pos = (pos + 1) % this.meta[META.maxSize];
                        exclusive || (slidingLock = this._lockLine(pos));
                    } else {
                        /* Now lets find the first free position (or a match of a preexising key) */
                        pos = (pos + 1) % this.meta[META.maxSize];
                        exclusive || (slidingLock = this._lockLineSliding(slidingLock, pos));
                    }
                } else {
                    /* We are following the collision chain here */
                    pos = this.chaining[pos];
                    exclusive || (slidingLock = this._lockLineSliding(slidingLock, pos));
                }
            }
            /* Copy the element into place, chaining when needed */
            this._write(pos, key, value);
            this.chaining[pos] = UINT32_UNDEFINED;
            /* Use Atomics to increase the length, we do not hold an exclusive lock here */
            Atomics.add(this.meta, META.length, 1);
            if (toChain !== undefined) {
                this.chaining[toChain] = pos;
                exclusive || this._unlockLine(toChain);
                toChain = undefined;
            }
            exclusive || this._unlockLine(slidingLock);
        } catch (e) {
            if (!exclusive) {
                this._unlockLine(slidingLock);
                if (toChain !== undefined)
                    this._unlockLine(toChain);
            }
            throw e;
        }
    }

    /**
    * @typedef SharedMapOptions
    * @type {object}
    * @property {boolean} lockWrite Already holding write lock, useful when manually locking with lockWrite
    * @property {boolean} lockExclusive Already holding exclusive lock, useful when manually locking with lockExclusive
    */

    /**
     * Add/replace an element, fully thread-safe, multiple get/set can execute in parallel
     * @param {string} key
     * @param {string|number} value
     * @param {SharedMapOptions} [opt] options, { lockWrite: true } if manually calling lockWrite
     * @throws {RangeError} when the map is full
     * @throws {RangeError} when the input values do not fit
     * @throws {TypeError} when the input values are of a wrong type
     * @return {void}
     */
    set(key, value, opt) {
        if (typeof key !== 'string' || key.length === 0)
            throw new TypeError(`SharedMap keys must be non-emptry strings, invalid key ${key}`);
        if (typeof value === 'number')
            value = value.toString();
        if (typeof value !== 'string')
            throw new TypeError('SharedMap can contain only strings and numbers which will be converted to strings');
        if (key.length > this.meta[META.keySize])
            throw new RangeError(`SharedMap key ${key} does not fit in ${this.meta[META.keySize] * Uint16Array.BYTES_PER_ELEMENT} bytes, ${this.meta[META.keySize]} UTF-16 code points`);
        if (value.length > this.meta[META.objSize])
            throw new RangeError(`SharedMap value ${value} does not fit in ${this.meta[META.objSize] * Uint16Array.BYTES_PER_ELEMENT} bytes, ${this.meta[META.objSize]} UTF-16 code points`);

        const lockHeld = opt && (opt.lockWrite || opt.lockExclusive);
        this.stats.set++;
        lockHeld || this._lockSharedWrite();
        try {
            this._set(key, value, lockHeld);
            lockHeld || this._unlockSharedWrite();
        } catch (e) {
            lockHeld || this._unlockSharedWrite();
            if (e instanceof Deadlock && !lockHeld) {
                this.lockExclusive();
                this.stats.deadlock++;
                try {
                    this._set(key, value, true);
                    this.unlockExclusive();
                } catch (e) {
                    this.unlockExclusive();
                    throw e;
                }
            } else
                throw e;
        }
    }

    /**
     * @private
     */
    _find(key, exclusive) {
        let slidingLock;
        try {
            /* Hash */
            let pos = this._hash(key);
            let previous = UINT32_UNDEFINED;
            this.stats.get++;
            exclusive || (slidingLock = this._lockLine(pos));
            /* Loop through the bucket chaining */
            while (pos !== UINT32_UNDEFINED && this.keysData[pos * this.meta[META.keySize]] !== 0) {
                if (this._match(key, pos)) {
                    return { pos, previous };
                }
                previous = pos;
                pos = this.chaining[pos];
                if (pos !== UINT32_UNDEFINED && !exclusive)
                    slidingLock = this._lockLineSliding(slidingLock, pos);
            }
            exclusive || this._unlockLine(slidingLock);
            return undefined;
        } catch (e) {
            exclusive || this._unlockLine(slidingLock);
            throw e;
        }
    }

    /**
     * Get an element, fully thread-safe, multiple get/set can execute in parallel
     * @param {string} key
     * @param {SharedMapOptions} [opt] options, { lockWrite: true } if manually calling lockWrite
     * @return {string|undefined}
     */
    get(key, opt) {
        let pos, val;
        const lockHeld = opt && (opt.lockWrite || opt.lockExclusive);
        lockHeld || this._lockSharedRead();
        try {
            pos = this._find(key, lockHeld);
            if (pos !== undefined) {
                val = this._decodeValue(pos.pos);
                lockHeld || this._unlockLine(pos.pos);
            }
            lockHeld || this._unlockSharedRead();
        } catch (e) {
            lockHeld || this._unlockSharedRead();
            if (e instanceof Deadlock && !lockHeld) {
                this.lockExclusive();
                this.stats.deadlock++;
                try {
                    pos = this._find(key, true);
                    if (pos !== undefined) {
                        val = this._decodeValue(pos.pos);
                    }
                    this.unlockExclusive();
                } catch (e) {
                    this.unlockExclusive();
                    throw e;
                }
            } else
                throw e;
        }
        return val;
    }

    /**
     * Find an element, fully thread-safe, identical to get(key) !== undefined
     * @param {string} key
     * @param {SharedMapOptions} [opt] options, { lockWrite: true } if manually calling lockWrite
     * @return {boolean}
     */
    has(key, opt) {
        return this.get(key, opt) !== undefined;
    }

    /**
     * @private
     */
    _hash(s) {
        if (typeof s.hash === 'function')
            return s.hash(s) % this.meta[META.maxSize];
        if (typeof s.hash === 'number')
            return s.hash % this.meta[META.maxSize];
        else
            return _hash(s) % this.meta[META.maxSize];
    }

    /**
     * Delete an element, fully thread-safe, acquires an exlusive lock and it is very expensive
     * @param {string} key
     * @param {SharedMapOptions} [opt] options, { lockExclusive: true } if manually calling lockExlusive
     * @throws {RangeError} when the key does not exit
     * @throws {Error} when calling map.delete(key, value, { lockWrite: true, lockExclusive: false })
     * @return {void}
     */
    delete(key, opt) {
        /* delete is slow */
        const lockHeld = opt && opt.lockExclusive;
        if (opt && opt.lockWrite && !lockHeld) {
            throw new Error('delete requires an exclusive lock');
        }
        let find;
        try {
            lockHeld || this.lockExclusive();
            find = this._find(key, true);
        } catch (e) {
            lockHeld || this.unlockExclusive();
            throw e;
        }
        if (find === undefined) {
            lockHeld || this.unlockExclusive();
            throw new RangeError(`SharedMap does not contain key ${key}`);
        }
        this.stats.delete++;
        const { pos, previous } = find;
        const next = this.chaining[pos];
        this.keysData[pos * this.meta[META.keySize]] = 0;
        if (previous !== UINT32_UNDEFINED)
            this.chaining[previous] = UINT32_UNDEFINED;
        Atomics.sub(this.meta, META.length, 1);
        if (next === UINT32_UNDEFINED) {
            /* There was no further chaining, just delete this element */
            /* and unchain it from the previous */
            lockHeld || this.unlockExclusive();
            return;
        }
        /* Full rechaining */
        /* Some slight optimization avoiding copying some elements around
         * is possible, but the O(n) complexity is not
         */
        this.stats.rechains++;
        let el = next;
        let chain = [];
        while (el !== UINT32_UNDEFINED) {
            chain.push({ key: this._decodeKey(el), value: this._decodeValue(el) });
            this.keysData[el * this.meta[META.keySize]] = 0;
            Atomics.sub(this.meta, META.length, 1);
            el = this.chaining[el];
        }
        for (el of chain) {
            this._set(el.key, el.value, true);
        }
        lockHeld || this.unlockExclusive();
    }

    /**
     * @private
     */
    *_keys(exclusive) {
        for (let pos = 0; pos < this.meta[META.maxSize]; pos++) {
            exclusive || this._lockSharedRead();
            exclusive || this._lockLine(pos);
            if (this.keysData[pos * this.meta[META.keySize]] !== 0) {
                yield pos;
            } else {
                exclusive || this._unlockLine(pos);
                exclusive || this._unlockSharedRead();
            }
        }
    }

    /**
     * A generator that can be used to iterate over the keys, thread-safe but allows
     * additions and deletions during the iteration
     * @param {SharedMapOptions} [opt] options, { lockWrite: true } if manually calling lockWrite
     * @return {Iterable}
     */
    *keys(opt) {
        const lockHeld = opt && (opt.lockWrite || opt.lockExclusive);
        for (let pos of this._keys(lockHeld)) {
            const k = this._decodeKey(pos);
            lockHeld || this._unlockLine(pos);
            lockHeld || this._unlockSharedRead();
            yield k;
        }
    }

    /**
     * @callback mapCallback callback(currentValue[, key] )}
     * map.get(key)=currentValue is guaranteed while the callback runs,
     * You shall not manipulate the map in the callback, use an explicitly-locked
     * keys() in this case (look at the example for lockWrite)
     *
     * @param {string} currentValue
     * @param {string} [key]
     */

    /**
     * A thread-safe map(). Doesn't block additions or deletions
     * between two calls of the callback,
     * all map operations are guaranteed atomic,
     * map.get(index)=currentValue is guaranteed while the callback runs,
     * You shall not manipulate the map in the callback, use an explicitly-locked
     * keys() in this case (look at the example for lockWrite)
     *
     * @param {mapCallback} cb callback
     * @param {*} [thisArg] callback will have its this set to thisArg
     * @return {Array}
     */
    map(cb, thisArg) {
        const a = [];
        for (let pos of this._keys()) {
            const k = this._decodeKey(pos);
            const v = this._decodeValue(pos);
            try {
                a.push(cb.call(thisArg, v, k));
                this._unlockLine(pos);
                this._unlockSharedRead();
            } catch (e) {
                this._unlockLine(pos);
                this._unlockSharedRead();
                throw e;
            }
        }
        return a;
    }

    /**
     * @callback reduceCallback callback(accumulator, currentValue[, key] )}
     * all map operations are guaranteed atomic,
     * map.get(key)=currentValue is guaranteed while the callback runs,
     * You shall not manipulate the map in the callback, use an explicitly-locked
     * keys() in this case (look at the example for lockWrite)
     *
     * @param accumulator
     * @param {string} currentValue
     * @param {string} [key]
     */

    /**
     * A thread-safe reduce(). Doesn't block additions or deletions
     * between two calls of the callback,
     * map.get(key)=currentValue is guaranteed while the callback runs,
     * You shall not manipulate the map in the callback, use an explicitly-locked
     * keys() in this case (look at the example for lockWrite)
     *
     * @param {reduceCallback} cb callback
     * @param {*} initialValue initial value of the accumulator
     * @return {*}
     */
    reduce(cb, initialValue) {
        let a = initialValue;
        for (let pos of this._keys(false)) {
            const k = this._decodeKey(pos);
            const v = this._decodeValue(pos);
            try {
                a = cb(a, v, k);
                this._unlockLine(pos);
                this._unlockSharedRead();
            } catch (e) {
                this._unlockLine(pos);
                this._unlockSharedRead();
                throw e;
            }
        }
        return a;
    }

    /**
     * Clear the SharedMap
     * @return {void}
     */
    clear() {
        this.lockExclusive();
        this.keysData.fill(0);
        this.valuesData.fill(0);
        Atomics.store(this.meta, META.length, 0);
        this.unlockExclusive();
    }
}

module.exports = SharedMap;