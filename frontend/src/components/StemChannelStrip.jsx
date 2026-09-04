import React from 'react';
import { useTranslation } from 'react-i18next';
import { Slider } from '../ui';

/**
 * StemChannelStrip — one instrument channel on the stem desk.
 *
 * Fader, mute, solo and a read-out of the gain the stem is ACTUALLY at, which
 * is not the same number as the fader: a solo somewhere else on the desk
 * silences this channel while its fader stays where the user left it. Showing
 * only the fader position would tell them a stem is at 80% while they hear
 * nothing, so the effective value is what the read-out reports and the strip
 * dims itself when that value is zero.
 *
 * Mute and solo are the standard console pair: mute always wins, and solo is
 * additive across strips.
 */
export default function StemChannelStrip({
  name,
  fader,
  mute,
  solo,
  effective,
  disabled = false,
  onFaderChange,
  onToggleMute,
  onToggleSolo,
}) {
  const { t } = useTranslation();
  const silent = effective === 0;
  const label = t(`stems.stem.${name}`);

  return (
    <div
      className={`stem-strip grid grid-cols-[minmax(72px,96px)_auto_1fr_auto] items-center gap-[var(--space-3)] border-b border-border px-[var(--space-3)] py-[var(--space-2)] last:border-b-0 ${
        silent ? 'opacity-55' : ''
      }`}
      data-stem={name}
      data-silent={silent ? 'true' : 'false'}
    >
      <span className="truncate text-[length:var(--text-sm)] font-semibold" title={label}>
        {label}
      </span>

      <div className="flex gap-[var(--space-1)]">
        <button
          type="button"
          disabled={disabled}
          onClick={onToggleMute}
          aria-pressed={mute}
          aria-label={t('stems.mute_stem', { stem: label })}
          className={`rounded-sm border px-[6px] py-px font-mono text-[length:var(--text-2xs)] tracking-[0.06em] transition-colors disabled:opacity-40 ${
            mute
              ? 'border-danger bg-danger text-fg-inverse'
              : 'border-border bg-bg-elev-2 text-fg-muted hover:border-danger'
          }`}
        >
          {t('stems.mute_short')}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onToggleSolo}
          aria-pressed={solo}
          aria-label={t('stems.solo_stem', { stem: label })}
          className={`rounded-sm border px-[6px] py-px font-mono text-[length:var(--text-2xs)] tracking-[0.06em] transition-colors disabled:opacity-40 ${
            solo
              ? 'border-accent bg-accent text-fg-inverse'
              : 'border-border bg-bg-elev-2 text-fg-muted hover:border-accent'
          }`}
        >
          {t('stems.solo_short')}
        </button>
      </div>

      <Slider
        value={Math.round(fader * 100)}
        onChange={(v) => onFaderChange(v / 100)}
        min={0}
        max={100}
        step={1}
        size="sm"
        showValue={false}
        disabled={disabled}
        aria-label={t('stems.level_for', { stem: label })}
      />

      <span
        className="min-w-[3.5em] text-right font-mono text-[length:var(--text-xs)] tabular-nums text-fg-muted"
        aria-live="off"
      >
        {Math.round(effective * 100)}%
      </span>
    </div>
  );
}
