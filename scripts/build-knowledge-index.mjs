import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFParse } from 'pdf-parse';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const knowledgeDir = resolve(root, 'knowledge');
const booksPath = resolve(knowledgeDir, 'books.local.json');
const indexPath = resolve(knowledgeDir, 'index.jsonl');
const metaPath = resolve(knowledgeDir, 'index.meta.json');

const maxChunkChars = 1400;
const overlapChars = 180;

if (!existsSync(booksPath)) {
  throw new Error(`Missing ${booksPath}. Add your local PDF paths before building the knowledge index.`);
}

mkdirSync(knowledgeDir, { recursive: true });

const books = JSON.parse(await readFile(booksPath, 'utf8'));
const indexLines = [];
const meta = {
  builtAt: new Date().toISOString(),
  chunkCount: 0,
  books: []
};

for (const book of books) {
  if (!existsSync(book.path)) {
    throw new Error(`Cannot find PDF for "${book.title}": ${book.path}`);
  }

  console.log(`Indexing ${book.title}`);
  const data = await readFile(book.path);
  const parser = new PDFParse({ data });
  const info = await parser.getInfo();
  const totalPages = info.total || 0;
  let bookChunks = 0;

  try {
    for (let page = 1; page <= totalPages; page += 1) {
      const result = await parser.getText({ partial: [page] });
      const pageText = cleanText(result.text);
      if (pageText.length < 80) continue;

      for (const chunkText of splitIntoChunks(pageText)) {
        const chunk = {
          id: `${book.id}:p${page}:c${bookChunks + 1}`,
          bookId: book.id,
          title: book.title,
          author: book.author,
          page,
          text: chunkText,
          terms: tokenize(`${book.title} ${book.author} ${chunkText}`)
        };
        indexLines.push(JSON.stringify(chunk));
        bookChunks += 1;
      }
    }
  } finally {
    await parser.destroy();
  }

  meta.books.push({
    id: book.id,
    title: book.title,
    author: book.author,
    pages: totalPages,
    chunks: bookChunks
  });
  meta.chunkCount += bookChunks;
}

writeFileSync(indexPath, `${indexLines.join('\n')}\n`, 'utf8');
writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

console.log(`Built ${meta.chunkCount} chunks from ${meta.books.length} books.`);
console.log(`Wrote ${indexPath}`);

function cleanText(text) {
  return String(text || '')
    .replace(/\u0000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitIntoChunks(text) {
  const chunks = [];
  let cursor = 0;

  while (cursor < text.length) {
    let end = Math.min(cursor + maxChunkChars, text.length);
    if (end < text.length) {
      const sentenceBreak = Math.max(
        text.lastIndexOf('. ', end),
        text.lastIndexOf('? ', end),
        text.lastIndexOf('! ', end),
        text.lastIndexOf('\n', end)
      );
      if (sentenceBreak > cursor + 500) end = sentenceBreak + 1;
    }

    const chunk = text.slice(cursor, end).trim();
    if (chunk.length >= 120) chunks.push(chunk);
    cursor = end >= text.length ? end : Math.max(cursor + 1, end - overlapChars);
  }

  return chunks;
}

function tokenize(text) {
  const words = String(text || '')
    .toLowerCase()
    .match(/[a-z][a-z'-]{2,}|[\u4e00-\u9fff]{2,}/g);
  return Array.from(new Set(words || [])).slice(0, 240);
}
