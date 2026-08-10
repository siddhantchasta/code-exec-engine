'use strict';

const assert = require('node:assert/strict');
const { LANGUAGES, getLanguage } = require('./lib/languages');

assert.deepEqual(Object.keys(LANGUAGES), ['python', 'javascript', 'cpp']);
assert.deepEqual(getLanguage('python').run, ['python3', '-u', '/code/main.py']);
assert.deepEqual(getLanguage('javascript').run, ['node', '--unhandled-rejections=strict', '/code/main.js']);
assert.deepEqual(getLanguage('cpp').compile, ['g++', '-O2', '-o', '/sandbox/main', '/code/main.cpp']);
assert.equal(getLanguage('not-a-language'), null);

process.stdout.write('language configuration tests passed\n');
