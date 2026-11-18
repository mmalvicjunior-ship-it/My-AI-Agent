import React from 'react';
import hljs, { languageForFile } from './highlight';

export default function CodeViewer({ content, filePath }) {
  const language = languageForFile(filePath);
  const highlighted = language
    ? hljs.highlight(content, { language, ignoreIllegals: true }).value
    : hljs.highlightAuto(content).value;
  return (
    <pre className="code-viewer">
      <code
        className={language ? `language-${language}` : undefined}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </pre>
  );
}
