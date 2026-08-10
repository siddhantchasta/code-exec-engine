'use strict';

/**
 * Language-specific sandbox configuration.
 * This is the sole location for image names, source filenames, and commands.
 */
const LANGUAGES = Object.freeze({
  python: Object.freeze({
    image: 'exec-sandbox-python:3.12',
    fileName: 'main.py',
    compile: null,
    run: ['python3', '-u', '/code/main.py'],
  }),
  javascript: Object.freeze({
    image: 'exec-sandbox-node:20',
    fileName: 'main.js',
    compile: null,
    run: ['node', '--unhandled-rejections=strict', '/code/main.js'],
  }),
  cpp: Object.freeze({
    image: 'exec-sandbox-cpp:13',
    fileName: 'main.cpp',
    compile: ['g++', '-O2', '-o', '/sandbox/main', '/code/main.cpp'],
    run: ['/sandbox/main'],
  }),
});

/**
 * @param {string} language
 * @returns {{ image: string, fileName: string, compile: string[] | null, run: string[] } | null}
 */
function getLanguage(language) {
  return LANGUAGES[language] ?? null;
}

module.exports = { LANGUAGES, getLanguage };
