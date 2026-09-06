/**
 * Making, renaming and removing flows: the three flow routes the Flows page needs and
 * the editor's own client (`api/flows.ts`, which reads and writes one open file) does
 * not have. The list lives in `api/flowsList.ts`.
 */

import type { FlowModel, FlowResponse } from '../model/types';
import { api } from './client';

const at = (path: string): string => `/flows/${encodeURIComponent(path)}`;

/** `empty` and `hello` are the server's two templates; a model is generated instead. */
export type FlowTemplate = 'empty' | 'hello' | { model: FlowModel };

export const createFlow = (path: string, template: FlowTemplate = 'empty') =>
  api.post<FlowResponse>('/flows', { path, template });

export const renameFlow = (path: string, to: string) =>
  api.post<FlowResponse>(`${at(path)}/rename`, { path: to });

export const deleteFlow = (path: string) => api.delete<{ ok: true }>(at(path));

/**
 * A file name from what the user typed: `Word count` becomes `word_count.py`, a path
 * they wrote out is kept as they wrote it. Empty until they type something.
 */
export function flowPathFrom(name: string): string {
  const trimmed = name.trim().replace(/^\/+/, '');
  if (!trimmed) return '';
  const withoutExtension = trimmed.replace(/\.py$/i, '');
  const cleaned = withoutExtension
    .split('/')
    .map((part) =>
      part
        .trim()
        .replace(/[^\w.-]+/g, '_')
        .replace(/^[_.]+|_+$/g, '')
        .toLowerCase(),
    )
    .filter(Boolean)
    .join('/');
  return cleaned ? `${cleaned}.py` : '';
}
