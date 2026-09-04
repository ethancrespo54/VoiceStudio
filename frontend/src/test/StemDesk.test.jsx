// Stem desk — six-stem separation and the channel-strip mixer.
//
// The behaviour worth pinning is the one users misread: a solo elsewhere on the
// desk silences a stem while its own fader stays put. If the strip reported the
// fader instead of the effective gain, it would read "80%" while the channel is
// silent. So the read-out, the dimming, and the underlying gain are asserted
// together.
//
// jsdom has no Web Audio, so the page's AudioContext is stubbed. That is enough
// to exercise wiring and rendering; the mixer's own audio behaviour is covered
// by src/lib/StemMixer.test.js against a fake context with a manual clock.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';

vi.mock('react-hot-toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const separateStems = vi.fn();
const loadStemBuffer = vi.fn();
vi.mock('../api/stems', async () => {
  const actual = await vi.importActual('../api/stems');
  return {
    ...actual,
    separateStems: (...a) => separateStems(...a),
    loadStemBuffer: (...a) => loadStemBuffer(...a),
  };
});

import StemDesk from '../pages/StemDesk';
import StemChannelStrip from '../components/StemChannelStrip';
import { FakeAudioContext, buffer } from './fakeAudio';

const STEMS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];

const withI18n = (node) => <I18nextProvider i18n={i18n}>{node}</I18nextProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  // The page constructs one AudioContext on mount.
  window.AudioContext = class extends FakeAudioContext {
    constructor() {
      super(0);
      this.state = 'running';
    }
    resume() {
      this.state = 'running';
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
  };
  separateStems.mockResolvedValue(
    Object.fromEntries(STEMS.map((s) => [s, `/stems/job1/${s}`])),
  );
  loadStemBuffer.mockImplementation(async () => buffer(210));
});

async function loadDesk() {
  render(withI18n(<StemDesk />));
  const input = screen.getByTestId('stem-file-input');
  const file = new File([new Uint8Array([1, 2, 3])], 'beat.wav', { type: 'audio/wav' });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(screen.getByText('Mix')).toBeInTheDocument());
}

describe('StemDesk', () => {
  it('shows the picker before anything is loaded', () => {
    render(withI18n(<StemDesk />));
    expect(screen.getByText('Choose file')).toBeInTheDocument();
    expect(screen.queryByText('Mix')).not.toBeInTheDocument();
  });

  it('renders one channel strip per stem after separation', async () => {
    await loadDesk();
    for (const name of STEMS) {
      expect(document.querySelector(`[data-stem="${name}"]`)).toBeTruthy();
    }
    expect(document.querySelectorAll('[data-stem]')).toHaveLength(6);
  });

  it('passes the chosen file through to the separation call', async () => {
    await loadDesk();
    expect(separateStems).toHaveBeenCalledTimes(1);
    expect(separateStems.mock.calls[0][0].name).toBe('beat.wav');
  });

  it('decodes every stem the backend returned', async () => {
    await loadDesk();
    expect(loadStemBuffer).toHaveBeenCalledTimes(6);
  });

  it('surfaces a separation failure instead of showing an empty desk', async () => {
    separateStems.mockRejectedValue(new Error('demucs exited 1: CUDA OOM'));
    render(withI18n(<StemDesk />));
    fireEvent.change(screen.getByTestId('stem-file-input'), {
      target: { files: [new File(['x'], 'beat.wav', { type: 'audio/wav' })] },
    });
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('CUDA OOM');
    expect(screen.queryByText('Mix')).not.toBeInTheDocument();
  });

  it('mutes a stem when its M button is pressed', async () => {
    await loadDesk();
    const vocals = document.querySelector('[data-stem="vocals"]');
    fireEvent.click(screen.getByLabelText('Mute Vocals'));
    await waitFor(() => expect(vocals.dataset.silent).toBe('true'));
  });

  it('a solo silences every other strip but leaves their faders alone', async () => {
    await loadDesk();
    fireEvent.click(screen.getByLabelText('Solo Drums'));

    await waitFor(() => {
      expect(document.querySelector('[data-stem="drums"]').dataset.silent).toBe('false');
    });
    for (const name of STEMS.filter((s) => s !== 'drums')) {
      expect(document.querySelector(`[data-stem="${name}"]`).dataset.silent).toBe('true');
    }
    // The read-out reports the EFFECTIVE gain, not the untouched fader.
    expect(document.querySelector('[data-stem="vocals"]')).toHaveTextContent('0%');
  });

  it('offers a clear-solo escape only while something is soloed', async () => {
    await loadDesk();
    expect(screen.queryByText('Clear solo')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Solo Piano'));
    await waitFor(() => expect(screen.getByText('Clear solo')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Clear solo'));
    await waitFor(() => {
      expect(document.querySelector('[data-stem="vocals"]').dataset.silent).toBe('false');
    });
  });

  it('warns when the stems are not the same length', async () => {
    const { toast } = await import('react-hot-toast');
    loadStemBuffer.mockImplementation(async (_ctx, url) =>
      url.endsWith('piano') ? buffer(200) : buffer(210),
    );
    await loadDesk();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('piano'));
  });

  it('states the guitar and piano quality ceiling on the desk', async () => {
    await loadDesk();
    expect(screen.getByText(/separate less cleanly/)).toBeInTheDocument();
  });
});

describe('StemChannelStrip', () => {
  const base = {
    name: 'guitar',
    fader: 0.8,
    mute: false,
    solo: false,
    effective: 0.8,
    onFaderChange: vi.fn(),
    onToggleMute: vi.fn(),
    onToggleSolo: vi.fn(),
  };

  it('reports the effective gain, not the fader position', () => {
    render(withI18n(<StemChannelStrip {...base} effective={0} />));
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.queryByText('80%')).not.toBeInTheDocument();
  });

  it('marks itself silent when the effective gain is zero', () => {
    const { container } = render(withI18n(<StemChannelStrip {...base} effective={0} />));
    expect(container.querySelector('[data-stem="guitar"]').dataset.silent).toBe('true');
  });

  it('reflects mute and solo state to assistive tech', () => {
    render(withI18n(<StemChannelStrip {...base} mute solo effective={0} />));
    expect(screen.getByLabelText('Mute Guitar')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Solo Guitar')).toHaveAttribute('aria-pressed', 'true');
  });

  it('uses the translated instrument name', () => {
    render(withI18n(<StemChannelStrip {...base} />));
    expect(screen.getByText('Guitar')).toBeInTheDocument();
  });
});
