/**
 * Minimal ambient types for the Plotly.js CDN global (loaded via <script> in
 * index.html, same as the vanilla app — deliberately not adding plotly.js /
 * react-plotly.js as bundled deps to keep parity with the original's
 * footprint). Only covers the handful of calls this app actually makes.
 */
interface PlotlyClickEvent {
  points?: Array<{ x: number; y: number; customdata?: unknown }>;
}

interface PlotlyHTMLElement extends HTMLDivElement {
  on(event: "plotly_click", handler: (e: PlotlyClickEvent) => void): void;
  data?: unknown;
}

interface PlotlyStatic {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  react(el: HTMLElement | string, data: any[], layout?: any, config?: any): Promise<void>;
  Plots: {
    resize(el: HTMLElement | string): void;
  };
}

declare const Plotly: PlotlyStatic;
interface Window {
  Plotly: PlotlyStatic;
}
