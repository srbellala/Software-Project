/**
 * Lazily injects the Plotly CDN script (~4.5MB) on first use instead of
 * blocking every page load with it in <head> — Load/Preview/Fit never touch
 * Plotly, so they shouldn't pay for it. Memoized: safe to call from many
 * PlotlyChart instances at once, and cheap to call speculatively (e.g. from
 * FitStep, to start the download in the background while a fit runs).
 */
let plotlyPromise: Promise<void> | null = null;

export function loadPlotly(): Promise<void> {
  if (typeof window !== "undefined" && window.Plotly) return Promise.resolve();
  if (plotlyPromise) return plotlyPromise;

  plotlyPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.plot.ly/plotly-2.35.2.min.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      plotlyPromise = null; // allow retry on next call
      reject(new Error("Failed to load Plotly"));
    };
    document.head.appendChild(script);
  });
  return plotlyPromise;
}
