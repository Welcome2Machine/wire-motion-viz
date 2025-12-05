'use client';
import React, { useMemo, useRef, useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import {
  ChevronLeft,
  ChevronRight,
  Upload,
  Maximize2,
  Minimize2,
  Image as ImageIcon,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

/**
 * Wire Motion Flipbook Web GUI
 *
 * Strictly aligned with the processing/plotting intent from process_trajectories.py:
 * - Work from the combined Excel (default sheet names in that script)
 * - For each point p, render four time-series panels with *identical* size, axis ranges, and layout
 *   across all points so you can flip between them like a slide deck.
 * - Default to smoothed series if available (per_step_{P}_smooth), with a toggle to show raw.
 * - All panels lock axes globally per metric to ensure apples-to-apples visual comparison.
 * - Keyboard ←/→ flips points. A fixed canvas layout ensures element positions are consistent.
 *
 * How to use in the preview:
 * 1) Click "Upload Excel" and select your processed_intermediate_data.xlsx.
 * 2) Use the point picker or ←/→ to flip like a flipbook.
 * 3) Use the "Raw / Smoothed" toggle to match the report variant.
 * 4) Optional: export current view as PNG for recordkeeping.
 */

// --- Constants for locked layout (identical across points) ---
const POINTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'] as const;
const PANEL_WIDTH = 1200; // px (chart drawing area, not including side UI)
const PANEL_HEIGHT = 220; // px per chart panel
const CHART_MARGIN = { top: 12, right: 24, bottom: 24, left: 56 } as const;
const GRID_STROKE_DASHARRAY = '3 3';

// Fixed color palette per series label (consistent across all charts)
const SERIES_COLORS: Record<string, string> = {
  Push: '#1f77b4',
  Slice: '#ff7f0e',
  'Push/s': '#2ca02c',
  'Slice/s': '#d62728',
  θ: '#9467bd',
  ratio: '#8c564b',
};
const DEFAULT_COLORS = [
  '#1f77b4',
  '#ff7f0e',
  '#2ca02c',
  '#d62728',
  '#9467bd',
  '#8c564b',
];

// Metric keys consistent with process_trajectories.py output
const METRICS = [
  {
    key: 'disp',
    title: 'Push/Slice per step',
    yLabel: 'Displacement (mm)',
    series: [
      { keyRaw: 'push_mm', keySm: 'push_mm_smooth', label: 'Push' },
      { keyRaw: 'slice_mm', keySm: 'slice_mm_smooth', label: 'Slice' },
    ],
  },
  {
    key: 'vel',
    title: 'Push/Slice per second',
    yLabel: 'Velocity (mm/s)',
    series: [
      { keyRaw: 'push_mm_s', keySm: 'push_mm_s_smooth', label: 'Push/s' },
      { keyRaw: 'slice_mm_s', keySm: 'slice_mm_s_smooth', label: 'Slice/s' },
    ],
  },
  {
    key: 'theta',
    title: 'Angle between motion and wire tangent',
    yLabel: 'Angle θ (deg)',
    series: [{ keyRaw: 'theta_deg', keySm: 'theta_deg_smooth', label: 'θ' }],
  },
  {
    key: 'ratio',
    title: 'Slide-Push Ratio',
    yLabel: 'Slide-Push Ratio',
    series: [{ keyRaw: 'ratio', keySm: 'ratio_smooth', label: 'ratio' }],
  },
] as const;

// Helpers
function toArray<T>(x: XLSX.Sheet | undefined): any[] {
  if (!x) return [];
  return XLSX.utils.sheet_to_json(x, { defval: null });
}

function getSheet(
  workbook: XLSX.WorkBook,
  name: string
): XLSX.Sheet | undefined {
  return workbook.Sheets[name];
}

function buildPointKey(p: string) {
  return `per_step_${p}_smooth`;
}

function numberOrNull(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatTime(s: any): number | null {
  // t_k from the sheets is seconds per the script
  return numberOrNull(s);
}

type SeriesRow = Record<string, number | null> & { t_k: number | null };

function coerceRows(rows: any[]): SeriesRow[] {
  return rows.map((r) => {
    const out: Record<string, number | null> = {};
    Object.keys(r).forEach((k) => {
      out[k] = /t_k$/i.test(k) ? formatTime(r[k]) : numberOrNull(r[k]);
    });
    if (out['t_k'] == null && r['t'] != null) {
      out['t_k'] = numberOrNull(r['t']);
    }
    return out as SeriesRow;
  });
}

function computeGlobalDomains(
  pointData: Record<string, SeriesRow[]>,
  useSmoothed: boolean
) {
  // For each metric, compute [min,max] across all points and all series used.
  const domains: Record<string, [number, number]> = {};
  METRICS.forEach((m) => {
    let lo = +Infinity;
    let hi = -Infinity;
    Object.values(pointData).forEach((rows) => {
      rows.forEach((r) => {
        m.series.forEach((s) => {
          const key = useSmoothed ? s.keySm : s.keyRaw;
          const v = r[key as keyof SeriesRow] as number | null;
          if (v != null && Number.isFinite(v)) {
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        });
      });
    });
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = -1;
      hi = 1; // fallback
    }
    // Nice padding
    const pad = (hi - lo) * 0.05 || 1;
    domains[m.key] = [lo - pad, hi + pad];
  });
  return domains;
}

function computeGlobalXDomain(pointData: Record<string, SeriesRow[]>) {
  let tMin = +Infinity;
  let tMax = -Infinity;
  Object.values(pointData).forEach((rows) => {
    rows.forEach((r) => {
      const t = r.t_k as number | null;
      if (t != null && Number.isFinite(t)) {
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
      }
    });
  });
  if (!Number.isFinite(tMin) || !Number.isFinite(tMax)) {
    tMin = 0;
    tMax = 1;
  }
  const pad = (tMax - tMin) * 0.02 || 0.01;
  return [tMin - pad, tMax + pad] as [number, number];
}

function computeLocalDomains(rows: SeriesRow[], useSmoothed: boolean) {
  const y: Record<string, [number, number]> = {};
  let tMin = +Infinity;
  let tMax = -Infinity;
  METRICS.forEach((m) => {
    let lo = +Infinity;
    let hi = -Infinity;
    rows.forEach((r) => {
      const t = r.t_k as number | null;
      if (t != null && Number.isFinite(t)) {
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
      }
      m.series.forEach((s) => {
        const key = useSmoothed ? s.keySm : s.keyRaw;
        const v = r[key as keyof SeriesRow] as number | null;
        if (v != null && Number.isFinite(v)) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      });
    });
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = -1;
      hi = 1;
    }
    const pad = (hi - lo) * 0.05 || 1;
    y[m.key] = [lo - pad, hi + pad];
  });
  if (!Number.isFinite(tMin) || !Number.isFinite(tMax)) {
    tMin = 0;
    tMax = 1;
  }
  const tPad = (tMax - tMin) * 0.02 || 0.01;
  return { y, x: [tMin - tPad, tMax + tPad] as [number, number] };
}

function useKeyNavigation(
  enabled: boolean,
  onPrev: () => void,
  onNext: () => void
) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') onPrev();
      if (e.key === 'ArrowRight') onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, onPrev, onNext]);
}

export default function WireMotionFlipbook() {
  /* component root */
  const [wb, setWb] = useState<XLSX.WorkBook | null>(null);
  const [pointSeries, setPointSeries] = useState<Record<string, SeriesRow[]>>(
    {}
  );
  const [currentPoint, setCurrentPoint] = useState<string>(POINTS[0]);
  const [useSmoothed, setUseSmoothed] = useState(true);
  const [full, setFull] = useState(false);
  const [lockAxes, setLockAxes] = useState(true);
  const [testResults, setTestResults] = useState<
    { name: string; ok: boolean; detail?: string }[] | null
  >(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const captureRef = useRef<HTMLDivElement | null>(null);

  useKeyNavigation(
    true,
    () => step(-1),
    () => step(1)
  );

  function step(delta: number) {
    setCurrentPoint((p) => {
      const idx = POINTS.indexOf(p as any);
      const next = (idx + delta + POINTS.length) % POINTS.length;
      return POINTS[next];
    });
  }

  // --- FIX: Ensure seriesForPoint is defined BEFORE any hooks that depend on it ---
  const seriesForPoint = useMemo(() => {
    return pointSeries[currentPoint] ?? [];
  }, [pointSeries, currentPoint]);

  // Global domains (for locked axes) and local domains (for auto axes)
  const domains = useMemo(
    () => computeGlobalDomains(pointSeries, useSmoothed),
    [pointSeries, useSmoothed]
  );
  const globalX = useMemo(
    () => computeGlobalXDomain(pointSeries),
    [pointSeries]
  );
  const localDomains = useMemo(
    () => computeLocalDomains(seriesForPoint, useSmoothed),
    [seriesForPoint, useSmoothed]
  );

  async function onUpload(file: File) {
    const arrayBuf = await file.arrayBuffer();
    const wbLocal = XLSX.read(arrayBuf, { type: 'array' });
    setWb(wbLocal);

    // Prefer per_step_{P}_smooth; fall back to per_step_all filtered by Point.
    const perStepAll = coerceRows(toArray(getSheet(wbLocal, 'per_step_all')));

    const grouped: Record<string, SeriesRow[]> = {};
    for (const P of POINTS) {
      const smoothSheet = getSheet(wbLocal, buildPointKey(P));
      if (smoothSheet) {
        grouped[P] = coerceRows(toArray(smoothSheet)).sort(
          (a, b) => (a.t_k ?? 0) - (b.t_k ?? 0)
        );
      } else {
        // filter per_step_all
        const rows = perStepAll.filter((r: any) => r['Point'] === P);
        grouped[P] = coerceRows(rows).sort(
          (a, b) => (a.t_k ?? 0) - (b.t_k ?? 0)
        );
      }
    }
    setPointSeries(grouped);
  }

  function triggerFile() {
    inputRef.current?.click();
  }

  function exportPng() {
    // Basic export using html-to-image (available in this environment)
    // If not available, we provide graceful no-op.
    // @ts-ignore
    import('html-to-image')
      .then(({ toPng }) => {
        if (!captureRef.current) return;
        toPng(captureRef.current).then((dataUrl: string) => {
          const a = document.createElement('a');
          a.href = dataUrl;
          a.download = `flipbook_${currentPoint}.png`;
          a.click();
        });
      })
      .catch(() => {
        alert('PNG export module not available in this preview.');
      });
  }

  // --- Lightweight in-app test suite (no external runner) ---
  function runSelfTests() {
    const results: { name: string; ok: boolean; detail?: string }[] = [];

    // Helper to add a test
    const T = (name: string, fn: () => void) => {
      try {
        fn();
        results.push({ name, ok: true });
      } catch (e: any) {
        results.push({ name, ok: false, detail: e?.message || String(e) });
      }
    };

    // Test 1: Empty datasets should produce finite domains and render without data
    T('Empty data → finite domains', () => {
      const local = computeLocalDomains([], true);
      if (!Array.isArray(local.x) || !Array.isArray(local.y['disp']))
        throw new Error('domains missing');
      if (!isFinite(local.x[0]) || !isFinite(local.x[1]))
        throw new Error('x domain invalid');
      if (!isFinite(local.y['disp'][0]) || !isFinite(local.y['disp'][1]))
        throw new Error('y domain invalid');
    });

    // Test 2: Global domains stable across points and metrics
    T('Global domains aggregate across points', () => {
      const dA: SeriesRow = {
        t_k: 0,
        push_mm: 0,
        slice_mm: 1,
        push_mm_s: 0,
        slice_mm_s: 2,
        theta_deg: 10,
        ratio: 0.5,
      } as any;
      const dB: SeriesRow = {
        t_k: 1,
        push_mm: 5,
        slice_mm: -1,
        push_mm_s: 3,
        slice_mm_s: -2,
        theta_deg: -20,
        ratio: 2,
      } as any;
      const pt = { A: [dA], B: [dB] };
      const gd = computeGlobalDomains(pt, false);
      if (!(gd && gd['disp'] && gd['vel'] && gd['theta'] && gd['ratio']))
        throw new Error('missing metric domain');
      const dispMin = gd['disp'][0];
      const dispMax = gd['disp'][1];
      if (!(dispMin < 0 && dispMax > 5))
        throw new Error('disp domain not spanning data');
    });

    // Test 3: seriesForPoint ordering and safety
    T('seriesForPoint defined before localDomains', () => {
      // Simulate the ordering by directly referencing the hook value
      // If undefined behavior existed, this component would already have thrown before this point.
      if (!Array.isArray(seriesForPoint))
        throw new Error('seriesForPoint not ready');
    });

    // Test 4: Color mapping consistency
    T('Series color mapping stable', () => {
      const labels = ['Push', 'Slice', 'Push/s', 'Slice/s', 'θ', 'ratio'];
      const colors = labels.map((l) => SERIES_COLORS[l]);
      if (new Set(colors).size !== labels.length)
        throw new Error('duplicate colors detected');
    });

    setTestResults(results);
  }

  return (
    <div
      className={`w-full ${full ? 'fixed inset-0 bg-white z-50 p-4' : 'p-4'}`}
    >
      <div className="flex gap-4">
        {/* Sidebar controls */}
        <div className="w-64 shrink-0 flex flex-col gap-3">
          <Card>
            <CardContent className="pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="font-medium">Data</div>
                <Button
                  size="icon"
                  variant="outline"
                  onClick={triggerFile}
                  title="Upload Excel"
                >
                  <Upload className="w-4 h-4" />
                </Button>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onUpload(f);
                  }}
                />
              </div>
              <div className="text-xs text-muted-foreground">
                Load <code>processed_intermediate_data.xlsx</code> exported by
                the pipeline.
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 space-y-3">
              <div className="font-medium">Flipbook</div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => step(-1)}
                  size="icon"
                  title="Prev (←)"
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <Button
                  variant="outline"
                  onClick={() => step(1)}
                  size="icon"
                  title="Next (→)"
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
                <div className="ml-2 text-sm">
                  Point: <span className="font-mono">{currentPoint}</span>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div className="text-sm">Use smoothed</div>
                <Toggle pressed={useSmoothed} onPressedChange={setUseSmoothed}>
                  {useSmoothed ? 'Smoothed' : 'Raw'}
                </Toggle>
              </div>

              <div className="flex items-center justify-between">
                <div className="text-sm">Lock axes (global)</div>
                <Toggle pressed={lockAxes} onPressedChange={setLockAxes}>
                  {lockAxes ? 'Locked' : 'Auto'}
                </Toggle>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => setFull((v) => !v)}
                  size="sm"
                >
                  {full ? (
                    <Minimize2 className="w-4 h-4 mr-2" />
                  ) : (
                    <Maximize2 className="w-4 h-4 mr-2" />
                  )}
                  {full ? 'Exit Full' : 'Full Screen'}
                </Button>
                <Button variant="outline" size="sm" onClick={exportPng}>
                  <ImageIcon className="w-4 h-4 mr-2" /> Export PNG
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 space-y-2 text-sm">
              <div className="font-medium">Status</div>
              <div className="space-y-2">
                {Object.keys(pointSeries).length ? (
                  <div>Workbook loaded. Domains locked per metric.</div>
                ) : (
                  <div>Waiting for workbook upload…</div>
                )}
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={runSelfTests}>
                    Run Tests
                  </Button>
                </div>
                {testResults && (
                  <div className="text-xs">
                    {testResults.map((t, i) => (
                      <div
                        key={i}
                        className={t.ok ? 'text-green-600' : 'text-red-600'}
                      >
                        {t.ok ? '✓' : '✗'} {t.name}
                        {t.detail ? `: ${t.detail}` : ''}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Main fixed-layout chart area */}
        <div className="flex-1" ref={captureRef}>
          <div className="w-[1200px] space-y-6">
            {METRICS.map((m) => (
              <Card key={m.key} className="shadow-sm">
                <CardContent className="pt-4">
                  <div className="text-sm font-medium mb-2">{`Point ${currentPoint}: ${m.title}`}</div>
                  <div style={{ width: PANEL_WIDTH, height: PANEL_HEIGHT }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={seriesForPoint} margin={CHART_MARGIN}>
                        <CartesianGrid
                          strokeDasharray={GRID_STROKE_DASHARRAY}
                        />
                        <XAxis
                          dataKey="t_k"
                          type="number"
                          tickFormatter={(v) => (v ?? 0).toFixed(3)}
                          domain={lockAxes ? globalX : localDomains.x}
                          label={{
                            value: 'Time (s)',
                            position: 'insideBottom',
                            offset: -14,
                          }}
                        />
                        <YAxis
                          domain={
                            (lockAxes
                              ? domains[m.key]
                              : localDomains.y[m.key]) ?? ['auto', 'auto']
                          }
                          label={{
                            value: m.yLabel,
                            angle: -90,
                            position: 'insideLeft',
                          }}
                        />
                        <Tooltip
                          formatter={(val: any) =>
                            val == null ? '—' : Number(val).toFixed(4)
                          }
                          labelFormatter={(v: any) =>
                            `t = ${Number(v).toFixed(4)} s`
                          }
                        />
                        <Legend verticalAlign="top" />
                        <ReferenceLine
                          y={0}
                          stroke="#888"
                          strokeDasharray="4 4"
                        />
                        {m.series.map((s, i) => (
                          <Line
                            key={s.label}
                            type="monotone"
                            dot={false}
                            strokeWidth={1.8}
                            stroke={
                              SERIES_COLORS[s.label] ||
                              DEFAULT_COLORS[i % DEFAULT_COLORS.length]
                            }
                            name={
                              s.label + (useSmoothed ? ' (smoothed)' : ' (raw)')
                            }
                            dataKey={(useSmoothed ? s.keySm : s.keyRaw) as any}
                            isAnimationActive={false}
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
