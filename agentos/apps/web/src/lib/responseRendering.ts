export interface ResponseBlock {
  type: 'text' | 'code';
  lines: string[];
}

export const RESPONSE_CHUNK_SIZE = 80;
export const RESPONSE_CHUNK_THRESHOLD = RESPONSE_CHUNK_SIZE * 2;

export function getResponseLineCount(blocks: readonly ResponseBlock[]): number {
  return blocks.reduce((total, block) => total + Math.max(block.lines.length, 1), 0);
}

export function chunkResponseBlocks(blocks: readonly ResponseBlock[], chunkSize = RESPONSE_CHUNK_SIZE): ResponseBlock[][] {
  if (chunkSize < 1) throw new Error('chunkSize must be greater than zero');

  const chunks: ResponseBlock[][] = [];
  let currentChunk: ResponseBlock[] = [];
  let currentSize = 0;

  const pushChunk = () => {
    if (currentChunk.length > 0) chunks.push(currentChunk);
    currentChunk = [];
    currentSize = 0;
  };

  for (const block of blocks) {
    const blockSize = Math.max(block.lines.length, 1);
    if (block.lines.length === 0) {
      if (currentSize > 0 && currentSize + blockSize > chunkSize) pushChunk();
      currentChunk.push({ type: block.type, lines: [] });
      currentSize += blockSize;
      if (currentSize >= chunkSize) pushChunk();
      continue;
    }

    let offset = 0;
    while (offset < block.lines.length) {
      if (currentSize >= chunkSize) pushChunk();
      const available = chunkSize - currentSize;
      const nextOffset = Math.min(block.lines.length, offset + available);
      currentChunk.push({ type: block.type, lines: block.lines.slice(offset, nextOffset) });
      currentSize += nextOffset - offset;
      offset = nextOffset;
    }
  }

  pushChunk();
  return chunks;
}
