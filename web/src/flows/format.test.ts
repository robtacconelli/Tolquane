import { describe, expect, it } from 'vitest';
import { folderOf, formatSize, shortPath } from './format';

describe('formatSize', () => {
  it('reads bytes, kilobytes and megabytes', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(573)).toBe('573 B');
    expect(formatSize(1024)).toBe('1.0 kB');
    expect(formatSize(1310)).toBe('1.3 kB');
    expect(formatSize(64_000)).toBe('63 kB');
    expect(formatSize(3_500_000)).toBe('3.3 MB');
  });
});

describe('folderOf', () => {
  it('is empty at the top of the workspace', () => {
    expect(folderOf('hello.py')).toBe('');
    expect(folderOf('reports/word_count.py')).toBe('reports');
    expect(folderOf('a/b/c.py')).toBe('a/b');
  });
});

describe('shortPath', () => {
  it('leaves a path that fits alone', () => {
    expect(shortPath('/home/me/flows')).toBe('/home/me/flows');
  });

  it('keeps the tail, which is the part that says where you are', () => {
    expect(shortPath('/tmp/a-very-long-uuid-like-directory-name/scratchpad/f5ws')).toBe(
      '…/scratchpad/f5ws',
    );
  });

  it('keeps at least the last segment, however long it is', () => {
    expect(shortPath('/a/b/' + 'x'.repeat(60))).toBe(`…/${'x'.repeat(60)}`);
  });
});
