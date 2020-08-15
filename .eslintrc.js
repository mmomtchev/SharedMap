module.exports = {
    env: {
        browser: true,
        commonjs: false,
        es6: true, /* eslint quirk, needed for UintArrays */
        node: true
    },
    extends: [
        'eslint:recommended'
    ],
    globals: {
        Atomics: 'readonly',
        SharedArrayBuffer: 'readonly',
    },
    parserOptions: {
        ecmaVersion: 2016,
        sourceType: 'module'
    },
    rules: {
        quotes: ['error', 'single'],
        semi: ['error', 'always']
    },
    overrides: [
        {
            files: ['index.es.js'],
            env: {
                browser: true,
                es6: true,
                commonjs: false,
                node: true
            }
        },
        {
            files: ['index.umd.js'],
            env: {
                browser: true,
                es6: true,
                commonjs: true,
                node: true
            },
            globals: {
                define: 'readonly'
            }
        }
    ]
};
