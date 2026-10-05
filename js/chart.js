// SVG line chart in the style of broker apps: no axes, a dotted reference
// line, a pulsing endpoint while live, and touch/mouse scrubbing that
// reports the point under the finger.

const SVG_NS = 'http://www.w3.org/2000/svg';
let nextId = 0;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function nearestIndex(points, t) {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1][0] - t) <= Math.abs(points[lo][0] - t)) return lo - 1;
  return lo;
}

export class LineChart {
  constructor(host, { height = 200, label = 'Verlauf', onScrub = () => {} } = {}) {
    this.host = host;
    this.height = height;
    this.onScrub = onScrub;
    this.gradientId = `chart-gradient-${++nextId}`;
    this.data = { points: [] };
    this.scrubT = null;
    this.geom = null;
    this.pointerActive = false;

    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'chart-svg');
    this.svg.setAttribute('role', 'img');
    this.svg.setAttribute('tabindex', '0');
    this.svg.setAttribute('aria-label', `${label}. Mit den Pfeiltasten durch die Werte gehen.`);
    host.replaceChildren(this.svg);
    this.bind();

    this.width = 0;
    this.resizeObserver = new ResizeObserver(() => {
      const width = Math.round(this.host.clientWidth);
      if (width !== this.width) this.draw();
    });
    this.resizeObserver.observe(host);
  }

  destroy() {
    this.resizeObserver.disconnect();
  }

  // data: {points:[[t, v]], domain?:[t0, t1], baseline?, refLines?:[{value, label, tone}], live?, emptyText?}
  update(data) {
    this.data = data;
    this.draw();
  }

  draw() {
    const { points = [], domain = null, baseline = null, refLines = [], live = false } = this.data;
    const width = Math.max(240, Math.round(this.host.clientWidth || 0));
    const height = this.height;
    this.width = width;
    const svg = this.svg;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));

    if (points.length < 2) {
      this.geom = null;
      const text = this.data.emptyText || 'Noch kein Verlauf';
      svg.innerHTML = `<text class="chart-empty" x="${width / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="middle">${esc(text)}</text>`;
      return;
    }

    const pad = { top: 22, bottom: 22, left: 0, right: 14 };
    const last = points[points.length - 1];
    const t0 = domain ? Math.min(domain[0], points[0][0]) : points[0][0];
    const t1 = Math.max(domain ? domain[1] : last[0], last[0]);

    let dataLo = Infinity;
    let dataHi = -Infinity;
    for (const [, v] of points) {
      if (v < dataLo) dataLo = v;
      if (v > dataHi) dataHi = v;
    }
    const dataSpan = Math.max(dataHi - dataLo, Math.abs(dataHi) * 0.002, 1e-6);
    let lo = dataLo;
    let hi = dataHi;
    if (baseline != null) {
      lo = Math.min(lo, baseline);
      hi = Math.max(hi, baseline);
    }
    // Reference lines widen the scale only while they sit near the data;
    // far-away ones are pinned to the top or bottom edge with an arrow.
    const refs = refLines.map((r) => ({
      ...r,
      near: r.value >= dataLo - dataSpan * 0.75 && r.value <= dataHi + dataSpan * 0.75,
    }));
    for (const r of refs) {
      if (r.near) {
        lo = Math.min(lo, r.value);
        hi = Math.max(hi, r.value);
      }
    }
    if (hi - lo < 1e-9) {
      lo -= 1;
      hi += 1;
    }
    const margin = (hi - lo) * 0.08;
    lo -= margin;
    hi += margin;

    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const x = (t) => pad.left + ((t - t0) / (t1 - t0 || 1)) * plotW;
    const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * plotH;

    const reference = baseline ?? points[0][1];
    const delta = last[1] - reference;
    const tone = Math.abs(delta) < Math.abs(reference) * 1e-6 ? 'flat' : delta > 0 ? 'pos' : 'neg';

    const xs = points.map(([t]) => x(t));
    const ys = points.map(([, v]) => y(v));
    let line = '';
    for (let i = 0; i < points.length; i++) line += `${i ? 'L' : 'M'}${xs[i].toFixed(1)} ${ys[i].toFixed(1)}`;
    const ex = xs[xs.length - 1];
    const ey = ys[ys.length - 1];
    const area = `${line}L${ex.toFixed(1)} ${height}L${xs[0].toFixed(1)} ${height}Z`;

    let extras = '';
    if (baseline != null) {
      const by = y(baseline).toFixed(1);
      extras += `<line class="chart-baseline" x1="0" x2="${width}" y1="${by}" y2="${by}"/>`;
    }
    // Labels never sit on top of each other: each one moves away from those already placed.
    const labelYs = [];
    const placeLabel = (wanted, step) => {
      let ly = wanted;
      while (labelYs.some((u) => Math.abs(u - ly) < 13)) ly += step;
      labelYs.push(ly);
      return ly;
    };
    for (const r of refs) {
      const cls = `chart-ref chart-ref-${r.tone || 'neutral'}`;
      if (r.near) {
        const ry = y(r.value);
        const labelY = placeLabel(ry - 6 < 12 ? ry + 14 : ry - 6, 13);
        extras += `<line class="${cls}" x1="0" x2="${width}" y1="${ry.toFixed(1)}" y2="${ry.toFixed(1)}"/>`;
        extras += `<text class="chart-ref-label ${cls}" x="16" y="${labelY.toFixed(1)}">${esc(r.label)}</text>`;
      } else {
        const above = r.value > hi;
        const labelY = above ? placeLabel(14, 13) : placeLabel(height - 6, -13);
        extras += `<text class="chart-ref-label ${cls}" x="16" y="${labelY}">${above ? '↑' : '↓'} ${esc(r.label)}</text>`;
      }
    }

    let scrub = '';
    if (this.scrubT != null) {
      const i = nearestIndex(points, this.scrubT);
      scrub =
        `<line class="chart-scrub" x1="${xs[i].toFixed(1)}" x2="${xs[i].toFixed(1)}" y1="0" y2="${height}"/>` +
        `<circle class="chart-scrub-dot chart-${tone}" cx="${xs[i].toFixed(1)}" cy="${ys[i].toFixed(1)}" r="5.5"/>`;
    }

    const halo = live ? `<circle class="chart-halo chart-${tone}" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4"/>` : '';
    svg.innerHTML =
      `<defs><linearGradient id="${this.gradientId}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" class="chart-stop-${tone}" stop-opacity="0.2"/>` +
      `<stop offset="1" class="chart-stop-${tone}" stop-opacity="0"/>` +
      `</linearGradient></defs>` +
      `<path class="chart-area" d="${area}" fill="url(#${this.gradientId})"/>` +
      extras +
      `<path class="chart-line chart-${tone}" d="${line}" fill="none"/>` +
      halo +
      `<circle class="chart-dot chart-${tone}" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4"/>` +
      scrub;
    this.geom = { xs, points };
  }

  bind() {
    const svg = this.svg;
    const scrubFromEvent = (event) => {
      if (!this.geom) return;
      const rect = svg.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / (rect.width || 1)) * this.width;
      const { xs, points } = this.geom;
      let best = 0;
      for (let i = 1; i < xs.length; i++) {
        if (Math.abs(xs[i] - px) < Math.abs(xs[best] - px)) best = i;
      }
      if (this.scrubT !== points[best][0]) {
        this.scrubT = points[best][0];
        this.draw();
        this.emit();
      }
    };
    svg.addEventListener('pointerdown', (event) => {
      this.pointerActive = true;
      scrubFromEvent(event);
    });
    svg.addEventListener('pointermove', (event) => {
      if (this.pointerActive || event.pointerType === 'mouse') scrubFromEvent(event);
    });
    const end = () => {
      this.pointerActive = false;
      this.clearScrub();
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', end);
    svg.addEventListener('blur', () => this.clearScrub());
    svg.addEventListener('keydown', (event) => {
      if (!this.geom) return;
      const { points } = this.geom;
      if (event.key === 'Escape') {
        this.clearScrub();
        return;
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      let i = this.scrubT == null ? points.length - 1 : nearestIndex(points, this.scrubT);
      i = event.key === 'ArrowLeft' ? Math.max(0, i - 1) : Math.min(points.length - 1, i + 1);
      this.scrubT = points[i][0];
      this.draw();
      this.emit();
    });
  }

  emit() {
    if (!this.geom || this.scrubT == null) return;
    const { points } = this.geom;
    const i = nearestIndex(points, this.scrubT);
    this.onScrub({ t: points[i][0], v: points[i][1] });
  }

  clearScrub() {
    if (this.scrubT == null) return;
    this.scrubT = null;
    this.draw();
    this.onScrub(null);
  }
}
