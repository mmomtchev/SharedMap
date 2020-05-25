# SharedMap

 * ***zero-dependency***
 * Vanilla JS Implementation of SharedMap,
 * a synchronous multi-threading capable,
 * fine-grained locked with deadlock recovery,
 * static memory allocated,
 * coalesced-chaining HashMap,
 * backed by **SharedArrayBuffer**
 * that supports deleting
 * and is capable of auto-defragmenting itself on delete unless almost full

## Introduction

Due to its legacy as a simple Web page glue, JS has what is probably the absolutely worst support of multi-threading among all languages created in the last few decades.

As the language matures, driven by a remarkably well implemented engine (V8) and the unique promise of unifying back-end, front-end and desktop application development, real multi-threading for CPU-bound tasks is becoming an absolute necessity.
In a true JS spirit, a feature after feature is added, some projects implementing it, others boycotting it, leaving it to the crowd to eventually decide what is worth supporting and what is not. As much as this can appear appalling to computer language experts, it is in a quite a way reminiscent of how the Linux kernel imposted itself vs the tech giants 20 years ago, and this is how JS is today on its way to total dominance for the years to come.

The current situation with **SharedArrayBuffer** is a perfect example of this JS spirit. In the hope that at some point in the near future Firefox will re-enable it by default, and Safari will implement it, **SharedMap** is proposed as a working solution for computationally-heavy back-end programs executing in Node.js.

**SharedMap** is browser-compatible in theory, but on the front-end side, when one of the major browsers is completely missing, and another one requires the user to go through a security warning to enable an obscure feature, its usefulness will be severely limited. For this reason I haven't even bothered to include an ES Modules interface.

**SharedMap** was motivated by [igc-xc-score](https://github.com/mmomtchev/igc-xc-score), a linear optimization solver for scoring paragliding flights. When I started it, I initially tried Python because of its flawless multi-threading and then I slowly realized that the single-threaded V8 implementation was faster then the 4-way multi-threaded Python3 (and PyPy) implementation. Love it or hate it, JS is here to stay for the years to come.

## About

Because of the severe limitations that **SharedArrayBuffer** imposes, **SharedMap** supports only numbers and strings and uses fixed memory allocation. It uses synchronous locking, implemented on the top of the **Atomics** interface.

The HashMap is a coalesced HashMap and has almost no performance drop up to 95% fill ratio and it is still usable up to 99.99%.
This chart shows the performance drop for a SharedMap with 370k English words and 4:8:1 ratio of *set/get/delete* operations:

![Performance Chart](https://gist.githubusercontent.com/mmomtchev/01f50eedac8d2a61346a9a0f373c24e4/raw/b49d0130e16c24137b56efa87540c84544b1630f/performance.png)

The default hash function is MurmurHash2 which works very well for words. You can provide your own hash function by override the *hash* property.

It supports deleting and will rechain itself when needed. The rechaining can be quite small and can be further optimized.

It supports single line locking with deadlock recovery at the moment. Unless a deadlock is detected, *get* and *set* require only a shared global lock and lock exclusively no more than two lines and so multiple operations can run in parallel. *delete* requires an exclusive lock and it is slow.

## Installation

```bash
npm install sharedmap
```

## Usage
```js
const SharedMap = require('SharedMap');

const MAPSIZE = 128 * 1024 * 1024;
const KEYSIZE = 48;                 // Do not forget that JS uses UTF-16 encoding
const OBJSIZE = 16;
const NWORKERS = require('os').cpus().length;

if (workerThreads.isMainThread) {
    const myMap = new SharedMap(MAPSIZE, KEYSIZE, OBJSIZE);
    workers = new Array(NWORKERS).fill(undefined);
    for (let w in workers) {
        workers[w] = new workerThreads.Worker('./test.js', { workerData: { map: myMap } });
    }
} else {
    const myMap = workerThreads.workerData.map;     // You can also send it through a MessagePort
    myMap.__proto__ = SharedMap.prototype;          // You have to manually restore the prototype

    myMap.set('prop1', 'val1');
    myMap.set('prop2', 12);
    console.assert(myMap.get('prop1') == 'val1');
    console.assert(myMap.get('prop2') == '12');     // Numbers will be converted to strings
    myMap.set('prop3', JSON.Stringify('a'));        // You can store objects if you serialize them
    myMap.delete('prop2');
    console.assert(myMap.hash('prop2') == false);
    console.assert(myMap.length === 1);
    for (let k of myMap.keys())                     // SharedMap.keys() is a generator
        console.assert(myMap.has(k));
    const allKeys = Array.from(myMap.keys());
    myMap.clear();
}

```

## TODO and contributing

* Avoid unncessary copying when rechaining on delete

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

Please make sure to update tests as appropriate.

## License
[LGPL](https://choosealicense.com/licenses/lgpl-3.0/)
