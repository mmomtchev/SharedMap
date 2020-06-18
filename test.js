const workerThreads = require('worker_threads');
const SharedMap = require('./index.umd');

const dict = require('./words_dictionary.json');
const words = Object.keys(dict);

const MAPSIZE = Math.floor(words.length * 1.01);
const KEYSIZE = 48;
const OBJSIZE = 16;
const NWORKERS = require('os').cpus().length;
const PASSES = 4;

function testMap(map, mypart, parts, out) {
    const t0 = Date.now();
    for (let pass = 0; pass < PASSES; pass++) {
        out(`t: ${mypart} pass ${pass} of ${PASSES}`);
        /**
         * Test 1: Interleaved write
         */
        for (let i = mypart; i < words.length; i += parts) {
            map.set(words[i], i);
        }
        out(`t: ${mypart} ${map.length}/${map.size} elements in map`);

        /**
         * Test 2: Interleaved read of all words written during Test 1
         */
        for (let i = mypart; i < words.length; i += parts) {
            const v = map.get(words[i]);
            if (+v != i)
                throw new Error(`value mismatch ${words[i]} ${i} != ${+v}`);
        }

        /**
         * Test 3: Reading of all words, including those written by other threads
         * Some could have been deleted during Test 4, but those present should
         * have correct values
         */
        for (let i = mypart; i < words.length; i++) {
            const v = map.get(words[i]);
            if (v !== undefined && +v != i)
                throw new Error(`value mismatch ${words[i]} ${i} != ${+v}`);
        }
        out(`t: ${mypart} ${map.length}/${map.size} elements in map`);

        /**
         * Test 4: Interleaved delete of 1/4th of all words
         */
        for (let i = mypart; i < words.length; i += 4 * parts) {
            map.delete(words[i]);
        }
        out(`t: ${mypart} ${map.length}/${map.size} elements in map`);

        /**
         * Test 5: Interleaved reading of all words, verifying that
         * words written in Test 1 are still there and words deleted
         * in Test 4 are missing
         */
        for (let i = mypart; i < words.length; i += parts) {
            if (i % (parts * 4) === mypart) {
                if (map.has(words[i]))
                    throw new Error(`element not deleted ${words[i]} = ${i}`);
            } else {
                const v = map.get(words[i]);
                if (+v != i)
                    throw new Error(`value mismatch ${words[i]} ${i} != ${+v}`);
            }
        }
        out(`t: ${mypart} ${map.length}/${map.size} elements in map`);

        /**
         * Test 6: Unlocked iteration of all keys
         * Values can disappear at any moment
         */
        let c = 0;
        for (let i of map.keys())
            if (map.get(i) === undefined)
                out(`t: ${mypart} value ${i} deleted under our nose`);
            else
                c++;
        out(`t: ${mypart} ${map.length}/${map.size} elements in map, counted ${c}`);

        /**
         * Test 7: Explicitly locked iteration of all keys
         * Rewriting values with opt.lockWrite=true
         */
        c = 0;
        let c2 = 0;
        map.lockWrite();
        for (let i of map.keys({ lockWrite: true })) {
            const v = +map.get(i, { lockWrite: true });
            if (v === undefined)
                throw new Error(`value ${i} deleted under our nose`);
            else
                c++;
            map.set(i, v, {lockWrite: true});
        }

        /**
         * Test 8: Locked reduce, count should be exact
         * !--reduce with explicit locking is not officialy supported--!
         */
        c2 = map.reduce((a) => a + 1, 0);
        if (c2 !== c)
            throw new Error(`counted ${c} != ${c2}`);
        out(`t: ${mypart} with writeLock ${map.length}/${map.size} elements in map, counted ${c} == ${c2}`);
        map.unlockWrite();

        /**
         * Test 9: Unlocked reduce, count is potentially false
         * by the time we are finished
         */
        c2 = map.reduce((a) => a + 1, 0);
        out(`t: ${mypart} unlocked reduce ${map.length}/${map.size} elements in map, counted ${c2}`);
    }
    const ops = map.stats.get + map.stats.set + map.stats.delete;
    const t = Date.now() - t0;
    out(`${ops} operations in ${(t / 1000).toFixed(3)}s, ${(ops / t * 1000).toFixed(0)} ops/s, fill ratio ${(words.length / map.size * 100).toFixed(2)}`);
}

if (workerThreads.isMainThread) {
    try {
        const mySmallMap = new SharedMap(4, KEYSIZE, OBJSIZE);
        for (let i = 0; i < 5; i++)
            mySmallMap.set('test' + i, i);
        throw new Error('no overflow exception');
    } catch (e) {
        if (!(e instanceof RangeError))
            throw e;
    }
    const myMap = new SharedMap(MAPSIZE, KEYSIZE, OBJSIZE);
    myMap.set('test', 2);
    myMap.set('test', 1);
    myMap.set('test2', 3);
    const mmap = myMap.map((v, k) => ({ k, v }));
    const accu = myMap.reduce((a, x) => a + (+x), 0);
    console.assert(mmap.length === 2);
    console.assert(myMap.get('test') === '1');
    console.assert(accu === 4);
    myMap.clear();
    console.assert(!myMap.has('test') && myMap.length === 0 && myMap.get('test') === undefined);
    try {
        myMap.delete('nonexisting');
        throw new Error('delete nonexisting succeeded');
    } catch (e) {
        if (!(e instanceof RangeError))
            throw e;
    }
    try {
        myMap.set('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'b');
        throw new Error('insert oversized key');
    } catch (e) {
        if (!(e instanceof RangeError))
            throw e;
    }
    try {
        myMap.set('b', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
        throw new Error('insert oversized value');
    } catch (e) {
        if (!(e instanceof RangeError))
            throw e;
    }
    const workers = new Array(NWORKERS).fill(undefined);
    for (let w in workers) {
        workers[w] = new workerThreads.Worker('./test.js', { workerData: { map: myMap, part: w, parts: NWORKERS } });
        workers[w].on('online', () => console.log(`worker ${w} started`));
        workers[w].on('message', (m) => console.log(m));
        workers[w].on('error', (e) => { console.log(e); myMap.__printMap(); });
        workers[w].on('exit', () => {
            console.log(`worker ${w} finished`);
            workers[w].finished = true;
            if (workers.reduce((a, x) => a && x.finished, true)) {
                let newMap = {};
                for (let k of myMap.keys()) {
                    if (newMap['xx' + k] !== undefined) {
                        console.log(k, newMap['xx' + k], myMap.get(k));
                        myMap.__printMap();
                        throw k;
                    }
                    newMap['xx' + k] = myMap.get(k);
                }
                console.log('all finished, checking consistency');
                const wordsDeleted = Math.ceil(Math.ceil(words.length / 4) / NWORKERS) * NWORKERS;
                if (myMap.length !== words.length - wordsDeleted)
                    throw new Error('wrong amount of values ' + myMap.length + ' should be ' + (words.length - wordsDeleted));
                for (let k of myMap.keys())
                    if (myMap.get(k) === undefined)
                        throw new Error('missing values');
            }
        });
    }
} else {
    const myMap = workerThreads.workerData.map;
    /* This needs a more elegant way of doing it
     * https://github.com/nodejs/help/issues/1558
     */
    Object.setPrototypeOf(myMap, SharedMap.prototype);

    testMap(myMap, +workerThreads.workerData.part, +workerThreads.workerData.parts,
        workerThreads.parentPort.postMessage.bind(workerThreads.parentPort));
}
