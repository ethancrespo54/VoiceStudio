import { apiFetch } from './client';

/** The six sources htdemucs_6s emits, in mixing-desk order. */
export const STEM_NAMES = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'] as const;
export type StemName = (typeof STEM_NAMES)[number];

export interface StemManifest {
  job_id: string;
  complete: boolean;
  stems: Partial<Record<StemName, { url: string; bytes: number }>>;
}

export interface SeparateHandlers {
  /** 0-100, already de-duplicated by the backend. */
  onProgress?: (percent: number) => void;
  /** Fired once the job id is known, before any separation work happens. */
  onStart?: (jobId: string) => void;
}

export class StemSeparationError extends Error {}

/**
 * Separate an audio file into six stems, resolving with stem-name -> URL.
 *
 * The backend answers with an SSE stream rather than a single JSON body
 * because separation runs for minutes; `onProgress` is what drives the bar.
 *
 * `done` and `error` are terminal and mutually exclusive. A stream that ends
 * without either means the connection dropped mid-separation, which is treated
 * as a failure rather than an empty success — silently resolving there would
 * hand the UI zero stems and no explanation.
 */
export async function separateStems(
  file: File,
  { onProgress, onStart }: SeparateHandlers = {},
  signal?: AbortSignal,
): Promise<Record<StemName, string>> {
  const form = new FormData();
  form.append('file', file);

  const res = await apiFetch('/stems/separate', { method: 'POST', body: form, signal });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      detail = (await res.json())?.detail ?? detail;
    } catch {
      /* non-JSON error body; the status is all we have */
    }
    throw new StemSeparationError(detail);
  }
  if (!res.body) throw new StemSeparationError('No response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let resolved: Record<StemName, string> | null = null;
  let failure: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let evt: any;
      try {
        evt = JSON.parse(line.slice(6));
      } catch {
        continue; // a partial frame; the next read completes it
      }
      if (evt.type === 'start') onStart?.(evt.job_id);
      else if (evt.type === 'progress') onProgress?.(evt.percent);
      else if (evt.type === 'done') resolved = evt.stems;
      else if (evt.type === 'error') failure = evt.error;
    }
  }

  if (failure) throw new StemSeparationError(failure);
  if (!resolved) throw new StemSeparationError('Separation ended without a result');
  return resolved;
}

export async function stemManifest(jobId: string): Promise<StemManifest> {
  const res = await apiFetch(`/stems/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new StemSeparationError(`HTTP ${res.status}`);
  return res.json();
}

export async function deleteStemJob(jobId: string): Promise<void> {
  const res = await apiFetch(`/stems/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  if (!res.ok) throw new StemSeparationError(`HTTP ${res.status}`);
}

/** Fetch one stem and decode it into an AudioBuffer the mixer can play. */
export async function loadStemBuffer(ctx: BaseAudioContext, url: string): Promise<AudioBuffer> {
  const res = await apiFetch(url);
  if (!res.ok) throw new StemSeparationError(`Could not fetch stem: HTTP ${res.status}`);
  return ctx.decodeAudioData(await res.arrayBuffer());
}
