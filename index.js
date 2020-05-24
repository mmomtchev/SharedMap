/* zero-dependency
 * Vanilla JS Implementation of SharedMap,
 * a synchronous multi - threading capable,
 * static memory allocated,
 * coalesced - chaining HashMap,
 * backed by SharedArrayBuffer
 * that supports deleting
 * and is capable of auto - defragmenting unless almost full
 * TODO: implement line locking with rollback on deadlock detection
 * delete with rechaining is the only operation which needs a full exclusive lock
 * compatible with both Node.js and SharedArrayBuffer - enabled browsers
 * @author <a href="mailto:momtchil@momtchev.com">Momtchil Momtchev</a>
 * @see http://github.com/mmomtchev/SharedMap
 */

const UINT32_UNDEFINED = 0xFFFFFFFF;
/* This is MurmurHash2 */
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
    SHARED: 0,
    EXCLUSIVE: 1,
    READERS: 2
};

class SharedMap {
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
        this.maplock = new Int32Array(this.storage, offset, Object.keys(LOCK).length);
        this.stats = { set: 0, delete: 0, collisions: 0, rechains: 0, get: 0 };
    }

    get length() {
        return this.meta[META.length];
    }

    get size() {
        return this.meta[META.maxSize];
    }

    _lock(l) {
        /* eslint-disable no-constant-condition */
        while (true) {
            let state;
            state = Atomics.exchange(this.maplock, l, 1);
            if (state == 0)
                return;
            Atomics.wait(this.maplock, l, state);
        }
        /* eslint-enable no-constant-condition */
    }

    _unlock(l) {
        const state = Atomics.exchange(this.maplock, l, 0);
        if (state == 0)
            throw new Error('maplock desync ' + l);
        Atomics.notify(this.maplock, l);
    }

    /* eslint-disable no-unused-vars */
    lockLine(pos) {
        /* TODO */
    }

    unlockLine(pos) {
        /* TODO */
    }
    /* eslint-enable no-unused-vars */

    lockMapExclusive() {
        this._lock(LOCK.EXCLUSIVE);
    }

    unlockMapExclusive() {
        this._unlock(LOCK.EXCLUSIVE);
    }

    lockMapShared() {
        this._lock(LOCK.SHARED);
        if (++this.maplock[LOCK.READERS] == 1)
            this._lock(LOCK.EXCLUSIVE);
        this._unlock(LOCK.SHARED);
    }

    unlockMapShared() {
        this._lock(LOCK.SHARED);
        if (--this.maplock[LOCK.READERS] == 0)
            this._unlock(LOCK.EXCLUSIVE);
        this._unlock(LOCK.SHARED);
    }

    _match(key, pos) {
        let i;
        for (i = 0; i < key.length; i++)
            if (this.keysData[pos * this.meta[META.keySize] + i] !== key.charCodeAt(i))
                break;
        return i === key.length && this.keysData[pos * this.meta[META.keySize] + i] === 0;
    }

    _decodeValue(pos) {
        const eos = this.valuesData.subarray(pos * this.meta[META.objSize], (pos + 1) * this.meta[META.objSize]).findIndex(x => x === 0);
        const end = eos < 0 ? (pos + 1) * this.meta[META.objSize] : pos * this.meta[META.objSize] + eos;
        return String.fromCharCode.apply(null, this.valuesData.subarray(pos * this.meta[META.objSize], end));
    }

    _decodeKey(pos) {
        const eos = this.keysData.subarray(pos * this.meta[META.keySize], (pos + 1) * this.meta[META.keySize]).findIndex(x => x === 0);
        const end = eos < 0 ? (pos + 1) * this.meta[META.keySize] : pos * this.meta[META.keySize] + eos;
        return String.fromCharCode.apply(null, this.keysData.subarray(pos * this.meta[META.keySize], end));
    }

    /* This is a debugging aid */
    _decodeBucket(pos, n) {
        return `pos: ${pos}`
            + ` hash: ${this._hash(this._decodeKey(pos))}`
            + ` key: ${this._decodeKey(pos)}`
            + ` value: ${this._decodeValue(pos)}`
            + ` chain: ${this.chaining[pos]}`
            + ((n > 0 && this.chaining[pos] !== UINT32_UNDEFINED) ? '\n' + (this._decodeBucket(this.chaining[pos], n - 1)) : '');
    }

    _set(key, value) {
        /* Hash */
        let pos = this._hash(key);
        /* Find the first free bucket, remembering the last occupied one to chain it */
        let toChain;
        while (this.keysData[pos * this.meta[META.keySize]] !== 0) {
            this.stats.collisions++;
            /* Replacing existing key */
            if (this._match(key, pos)) {
                for (let i = 0; i < value.length; i++)
                    this.valuesData[pos * this.meta[META.objSize] + i] = value.charCodeAt(i);
                return;
            }
            if (this.chaining[pos] === UINT32_UNDEFINED || toChain !== undefined) {
                /* This is the last collision element, we will chain ourselves to it */
                if (toChain == undefined)
                    toChain = pos;
                /* Now lets find the first free position (or a match of a preexising key) */
                pos = (pos + 1) % this.meta[META.maxSize];
            } else {
                /* We are following the collision chain here */
                pos = this.chaining[pos];
            }
        }
        if (this.meta[META.length] === this.meta[META.maxSize]) {
            throw new RangeError('SharedMap is full');
        }
        /* Copy the element into place, chaining when needed */
        if (toChain !== undefined)
            this.chaining[toChain] = pos;
        for (let i = 0; i < key.length; i++)
            this.keysData[pos * this.meta[META.keySize] + i] = key.charCodeAt(i);
        for (let i = 0; i < value.length; i++)
            this.valuesData[pos * this.meta[META.objSize] + i] = value.charCodeAt(i);
        this.chaining[pos] = UINT32_UNDEFINED;
        this.meta[META.length]++;
    }

    set(key, value) {
        if (typeof key !== 'string' || key.length === 0)
            throw new TypeError(`SharedMap keys must be non-emptry strings, invalid key ${JSON.stringify(key)}`);
        if (typeof value === 'number')
            value = value.toString();
        if (typeof value !== 'string')
            throw new TypeError('SharedMap can contain only strings and numbers which will be converted to strings');
        if (key.length > this.meta[META.keySize] << 1)
            throw new RangeError(`SharedMap key ${key} does not fit in ${this.meta[META.keySize] << 1} bytes, ${this.meta[META.keySize] << 1} UTF-16 code points`);
        if (value.length > this.meta[META.objSize] << 1)
            throw new RangeError(`SharedMap value ${value} does not fit in ${this.meta[META.objSize] << 1} bytes, ${this.meta[META.objSize] << 1} UTF-16 code points`);

        this.stats.set++;
        this.lockMapExclusive();
        try {
            this._set(key, value);
        } catch (e) {
            this.unlockMapExclusive();
            throw e;
        }
        this.unlockMapExclusive();
    }

    _find(key) {
        /* Hash */
        let pos = this._hash(key);
        let previous = UINT32_UNDEFINED;
        this.stats.get++;
        /* Loop through the bucket chaining */
        while (this.keysData[pos * this.meta[META.keySize]] !== 0 && pos !== UINT32_UNDEFINED) {
            if (this._match(key, pos)) {
                return { pos, previous };
            }
            previous = pos;
            pos = this.chaining[pos];
        }
        return undefined;
    }

    get(key) {
        this.lockMapShared();
        const pos = this._find(key);
        if (pos === undefined) {
            this.unlockMap();
            return undefined;
        }
        const v = this._decodeValue(pos.pos);
        this.unlockMapShared();
        return v;
    }

    has(key) {
        this.lockMapShared();
        const exists = this._find(key) !== undefined;
        this.unlockMapShared();
        return exists;
    }

    _hash(s) {
        if (typeof s.hash === 'function')
            return s.hash(s) % this.meta[META.maxSize];
        if (typeof s.hash === 'number')
            return s.hash % this.meta[META.maxSize];
        else
            return _hash(s) % this.meta[META.maxSize];
    }

    _clear(pos) {
        this.keysData.fill(0, pos * this.meta[META.keySize], (pos + 1) * this.meta[META.keySize]);
        this.valuesData.fill(0, pos * this.meta[META.objSize], (pos + 1) * this.meta[META.objSize]);
    }

    _copy(posnew, posold) {
        this.keysData.copyWithin(posnew * this.meta[META.keySize], posold * this.meta[META.keySize], (posold + 1) * this.meta[META.keySize]);
        this.valuesData.copyWithin(posnew * this.meta[META.objSize], posold * this.meta[META.objSize], (posold + 1) * this.meta[META.objSize]);
        this.chaining[posnew] = this.chaining[posold];
    }

    delete(key) {
        this.lockMapExclusive();
        const find = this._find(key);
        if (find === undefined) {
            this.unlockMap();
            throw RangeError(`SharedMap does not contain key ${key}`);
        }
        this.stats.delete++;
        const { pos, previous } = find;
        const next = this.chaining[pos];
        this._clear(pos);
        if (previous !== UINT32_UNDEFINED)
            this.chaining[previous] = UINT32_UNDEFINED;
        this.meta[META.length]--;
        if (next === UINT32_UNDEFINED) {
            /* There was no further chaining, just delete this element */
            /* and unchain it from the previous */
            this.unlockMapExclusive();
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
            this._clear(el);
            this.meta[META.length]--;
            el = this.chaining[el];
        }
        for (el of chain) {
            this._set(el.key, el.value);
        }
        this.unlockMapExclusive();
    }

    *keys() {
        for (let pos = 0; pos < this.meta[META.maxSize]; pos++) {
            this.lockMapShared();
            if (this.keysData[pos * this.meta[META.keySize]] !== 0) {
                const k = this._decodeKey(pos);
                this.unlockMapShared();
                yield k;
            } else
                this.unlockMapShared();
        }
    }

    clear() {
        this.lockMapExclusive();
        this.keysData.fill(0);
        this.valuesData.fill(0);
        this.meta[META.length] = 0;
        this.unlockMapExclusive();
    }
}

module.exports = SharedMap;
