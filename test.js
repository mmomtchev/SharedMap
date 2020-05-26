const workerThreads = require('worker_threads');
const SharedMap = require('./index');

const dict = require('./words_dictionary.json');
const words = Object.keys(dict);

const MAPSIZE = Math.floor(words.length * 1.05);
const KEYSIZE = 48;
const OBJSIZE = 16;
const NWORKERS = require('os').cpus().length;
const PASSES = 4;

function testMap(map, mypart, parts, out) {
    const t0 = Date.now();
    for (let pass = 0; pass < PASSES; pass++) {
        out(`t: ${mypart} pass ${pass} of ${PASSES}`);
        for (let i = mypart; i < words.length; i += parts) {
            map.set(words[i], i);
        }
        out(`t: ${mypart} ${map.length}/${map.size} elements in map`);

        for (let i = mypart; i < words.length; i += parts) {
            const v = map.get(words[i]);
            if (+v != i)
                throw new Error(`value mismatch ${words[i]} ${i} != ${+v}`);
        }
        for (let i = mypart; i < words.length; i++) {
            const v = map.get(words[i]);
            if (v !== undefined && +v != i)
                throw new Error(`value mismatch ${words[i]} ${i} != ${+v}`);
        }
        out(`t: ${mypart} ${map.length}/${map.size} elements in map`);

        for (let i = mypart; i < words.length; i += 4 * parts) {
            map.delete(words[i]);
        }
        out(`t: ${mypart} ${map.length}/${map.size} elements in map`);

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

        let c = 0;
        /* eslint-disable no-unused-vars */
        for (let i of map.keys())
            c++;
        /* eslint-enable no-unused-vars */
        out(`t: ${mypart} ${map.length}/${map.size} elements in map, counted ${c}`);
    }
    const ops = map.stats.get + map.stats.set + map.stats.delete;
    const t = Date.now() - t0;
    out(`${ops} operations in ${(t / 1000).toFixed(3)}s, ${(ops / t * 1000).toFixed(0)} ops/s, fill ratio ${(words.length / map.size * 100).toFixed(2)}`);
}

if (workerThreads.isMainThread) {
    const myMap = new SharedMap(MAPSIZE, KEYSIZE, OBJSIZE);
    myMap.set('test', 1);
    console.assert(myMap.get('test') === '1');
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
    myMap.__proto__ = SharedMap.prototype;

    testMap(myMap, +workerThreads.workerData.part, +workerThreads.workerData.parts,
        workerThreads.parentPort.postMessage.bind(workerThreads.parentPort));
}
