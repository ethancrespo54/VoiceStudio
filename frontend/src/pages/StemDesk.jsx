import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Music4, Play, Pause, Square, Upload } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { Panel, Button, Progress } from '../ui';
import StemChannelStrip from '../components/StemChannelStrip';
import { StemMixer } from '../lib/StemMixer';
import { STEM_NAMES, loadStemBuffer, separateStems } from '../api/stems';

const ACCEPT = '.wav,.flac,.mp3,.m4a,.aac,.ogg,.opus,.aiff,.aif';

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * StemDesk — separate a track into six instrument stems and mix them live.
 *
 * The desk owns an AudioContext and a StemMixer for the life of the page. Both
 * are refs rather than state: re-creating an AudioContext on render would
 * restart playback, and browsers cap how many a page may open.
 *
 * Playback position is polled on an animation frame rather than pushed from
 * the mixer, because the audio clock advances continuously and React has no
 * reason to re-render more often than the display refreshes.
 */
export default function StemDesk({ onBack }) {
  const { t } = useTranslation();

  const ctxRef = useRef(null);
  const mixerRef = useRef(null);
  const fileInputRef = useRef(null);
  const rafRef = useRef(0);

  const [phase, setPhase] = useState('idle'); // idle | separating | ready
  const [percent, setPercent] = useState(0);
  const [trackName, setTrackName] = useState('');
  const [mix, setMix] = useState(null); // mixer.state() snapshot
  const [position, setPosition] = useState(0);
  const [error, setError] = useState('');

  const syncMix = useCallback(() => {
    if (mixerRef.current) setMix(mixerRef.current.state());
  }, []);

  // One AudioContext + mixer for the page; disposed on unmount so leaving the
  // desk cannot leave audio playing behind it.
  useEffect(() => {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) {
      setError(t('stems.no_web_audio'));
      return undefined;
    }
    const ctx = new Ctor();
    ctxRef.current = ctx;
    mixerRef.current = new StemMixer(ctx);
    return () => {
      cancelAnimationFrame(rafRef.current);
      mixerRef.current?.dispose();
      ctx.close().catch(() => {
        /* already closed */
      });
    };
  }, [t]);

  // Position ticker — runs only while playing.
  useEffect(() => {
    if (!mix?.playing) {
      cancelAnimationFrame(rafRef.current);
      return undefined;
    }
    const tick = () => {
      const m = mixerRef.current;
      if (!m) return;
      setPosition(m.position);
      if (!m.playing) syncMix();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [mix?.playing, syncMix]);

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // let the same file be re-picked after a failure
    if (!file || !mixerRef.current) return;

    setPhase('separating');
    setPercent(0);
    setError('');
    setTrackName(file.name);

    try {
      const stems = await separateStems(file, { onProgress: setPercent });
      const buffers = {};
      await Promise.all(
        STEM_NAMES.filter((name) => stems[name]).map(async (name) => {
          buffers[name] = await loadStemBuffer(ctxRef.current, stems[name]);
        }),
      );
      mixerRef.current.load(buffers);

      const uneven = mixerRef.current.lengthMismatches(0.05);
      if (uneven.length) {
        toast.error(
          t('stems.uneven_warning', { stems: uneven.map((u) => u.name).join(', ') }),
        );
      }

      setPosition(0);
      syncMix();
      setPhase('ready');
    } catch (err) {
      setPhase('idle');
      setError(err?.message || String(err));
      toast.error(t('stems.separation_failed'));
    }
  };

  const togglePlay = async () => {
    const m = mixerRef.current;
    if (!m) return;
    // Browsers start the context suspended until a user gesture.
    if (ctxRef.current?.state === 'suspended') await ctxRef.current.resume();
    if (m.playing) m.pause();
    else m.play();
    syncMix();
  };

  const stop = () => {
    mixerRef.current?.stop();
    setPosition(0);
    syncMix();
  };

  const scrub = (event) => {
    const m = mixerRef.current;
    if (!m) return;
    const next = (Number(event.target.value) / 1000) * m.duration;
    m.seek(next);
    setPosition(next);
    syncMix();
  };

  const ready = phase === 'ready' && mix;
  const busy = phase === 'separating';
  const duration = mix?.duration ?? 0;

  return (
    <div className="stem-desk flex flex-1 flex-col gap-[var(--space-5)] min-h-0 overflow-y-auto px-[var(--space-6)] py-[var(--space-5)]">
      <div className="flex shrink-0 items-center gap-[var(--space-4)]">
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            {t('common.back')}
          </Button>
        )}
        <h1>
          <Music4 size={15} /> {t('stems.title')}
        </h1>
      </div>

      <Panel title={t('stems.source_title')}>
        <p className="mb-[var(--space-3)] text-[length:var(--text-xs)] text-fg-muted">
          {trackName || t('stems.source_hint')}
        </p>
        <div className="flex flex-wrap items-center gap-[var(--space-3)]">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            onChange={handleFile}
            className="hidden"
            data-testid="stem-file-input"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={14} /> {t('stems.choose_file')}
          </Button>
          {busy && (
            <span className="text-[length:var(--text-xs)] text-fg-muted">
              {t('stems.separating', { percent })}
            </span>
          )}
        </div>

        {busy && (
          <div className="mt-[var(--space-3)]">
            <Progress value={percent} />
            <p className="mt-[var(--space-2)] text-[length:var(--text-xs)] text-fg-muted">
              {t('stems.separating_note')}
            </p>
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="mt-[var(--space-3)] text-[length:var(--text-xs)] text-danger"
          >
            {error}
          </p>
        )}
      </Panel>

      {ready && (
        <Panel title={t('stems.desk_title')}>
          <p className="mb-[var(--space-3)] text-[length:var(--text-xs)] text-fg-muted">
            {t('stems.desk_hint')}
          </p>
          <div className="mb-[var(--space-4)] flex flex-wrap items-center gap-[var(--space-3)]">
            <Button variant="primary" size="sm" onClick={togglePlay}>
              {mix.playing ? <Pause size={14} /> : <Play size={14} />}
              {mix.playing ? t('stems.pause') : t('stems.play')}
            </Button>
            <Button variant="ghost" size="sm" onClick={stop}>
              <Square size={14} /> {t('stems.stop')}
            </Button>
            <span className="font-mono text-[length:var(--text-xs)] tabular-nums text-fg-muted">
              {formatTime(position)} / {formatTime(duration)}
            </span>
          </div>

          <input
            type="range"
            min={0}
            max={1000}
            step={1}
            value={duration ? Math.round((position / duration) * 1000) : 0}
            onChange={scrub}
            aria-label={t('stems.seek')}
            className="mb-[var(--space-4)] w-full accent-accent"
          />

          <div className="rounded-sm border border-border">
            {STEM_NAMES.filter((name) => mix.stems[name]).map((name) => {
              const stem = mix.stems[name];
              return (
                <StemChannelStrip
                  key={name}
                  name={name}
                  fader={stem.fader}
                  mute={stem.mute}
                  solo={stem.solo}
                  effective={stem.effective}
                  onFaderChange={(v) => {
                    mixerRef.current.setFader(name, v);
                    syncMix();
                  }}
                  onToggleMute={() => {
                    mixerRef.current.toggleMute(name);
                    syncMix();
                  }}
                  onToggleSolo={() => {
                    mixerRef.current.toggleSolo(name);
                    syncMix();
                  }}
                />
              );
            })}
          </div>

          {mix.anySolo && (
            <button
              type="button"
              onClick={() => {
                mixerRef.current.clearSolo();
                syncMix();
              }}
              className="mt-[var(--space-3)] text-[length:var(--text-xs)] text-accent underline"
            >
              {t('stems.clear_solo')}
            </button>
          )}

          <p className="mt-[var(--space-4)] text-[length:var(--text-xs)] text-fg-muted">
            {t('stems.quality_note')}
          </p>
        </Panel>
      )}
    </div>
  );
}
