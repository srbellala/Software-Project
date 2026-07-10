/**
 * Mirrors _buildParamTable / _updateDerived / _collectParams in static/app.js
 * exactly (same defaults, same derived-value formulas, same payload keys).
 */

export interface T2ParamState {
  s0RatioInit: number;
  s0RatioLo: number;
  s0RatioHi: number;
  t2Init: number;
  t2Lo: number;
  t2Hi: number;
  noiseInit: number;
  threshLo: number;
  threshHi: number;
  r2Thresh: number;
}

export interface T1ParamState {
  s0Init: number; // displayed but NOT sent to the backend — matches the vanilla app's _collectParams, which never reads this field either
  t1Init: number;
  t1Lo: number;
  t1Hi: number;
  r2Thresh: number;
}

export const DEFAULT_T2_PARAMS: T2ParamState = {
  s0RatioInit: 1.25,
  s0RatioLo: 1.05,
  s0RatioHi: 10.0,
  t2Init: 20.0,
  t2Lo: 0.00001,
  t2Hi: 4000,
  noiseInit: 1473,
  threshLo: 0.0,
  threshHi: 4000,
  r2Thresh: 0.5,
};

export const DEFAULT_T1_PARAMS: T1ParamState = {
  s0Init: 3000,
  t1Init: 1000,
  t1Lo: 10,
  t1Hi: 5000,
  r2Thresh: 0.5,
};

function fmt(v: number): string {
  if (v >= 1e4) return v.toExponential(1);
  if (v < 0.01) return v.toExponential(2);
  return `${+v.toPrecision(3)}`;
}

export function derivedR2(p: T2ParamState): { init: string; lo: string; hi: string } {
  const t2i = p.t2Init || 20;
  const t2h = p.t2Hi || 4000;
  const t2l = p.t2Lo || 1e-5;
  return {
    init: fmt(1000 / t2i),
    lo: fmt(1000 / t2h),
    hi: fmt(t2l > 0 ? 1000 / t2l : 1e8),
  };
}

export function derivedR1(p: T1ParamState): { init: string; lo: string; hi: string } {
  const t1i = p.t1Init || 1000;
  const t1h = p.t1Hi || 5000;
  const t1l = p.t1Lo || 10;
  return {
    init: (1000 / t1i).toFixed(3),
    lo: (1000 / t1h).toFixed(3),
    hi: (1000 / t1l).toFixed(1),
  };
}

export function collectT2Params(p: T2ParamState): Record<string, number> {
  return {
    s0_ratio_init: p.s0RatioInit,
    s0_ratio_lo: p.s0RatioLo,
    s0_ratio_hi: p.s0RatioHi,
    t2_init: p.t2Init,
    t2_lo: p.t2Lo,
    t2_hi: p.t2Hi,
    noise_init: p.noiseInit,
    thresh_lo: p.threshLo,
    thresh_hi: p.threshHi,
    r2_thresh: p.r2Thresh,
  };
}

export function collectT1Params(p: T1ParamState): Record<string, number> {
  return {
    t1_init: p.t1Init,
    t1_lo: p.t1Lo,
    t1_hi: p.t1Hi,
    r2_thresh: p.r2Thresh,
  };
}
