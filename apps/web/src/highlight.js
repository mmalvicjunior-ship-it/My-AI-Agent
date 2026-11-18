import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';

[
  ['javascript', javascript],
  ['typescript', typescript],
  ['python', python],
  ['json', json],
  ['bash', bash],
  ['css', css],
  ['xml', xml],
  ['sql', sql],
].forEach(([name, language]) => hljs.registerLanguage(name, language));

const EXTENSION_LANGUAGES = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  json: 'json',
  html: 'xml',
  htm: 'xml',
  css: 'css',
  sql: 'sql',
  sh: 'bash',
};

export function languageForFile(filePath) {
  const extension = String(filePath || '').split('.').pop()?.toLowerCase();
  return EXTENSION_LANGUAGES[extension] || null;
}

export default hljs;
