'use strict';
'require baseclass';
'require dom';

/*
 * charts.js -- dependency-free inline-SVG time-series charts.
 *
 * A ChartGroup is the shared clock and view of the charts on one card:
 * call group.tick() once per poll, then chart.push(sample) on each chart.
 * The group owns the visible time window (range buttons, drag-to-zoom,
 * double-click to reset) and a synced hover cursor, so zooming or hovering
 * one chart does the same on every chart of the card.
 *
 * var g = new charts.ChartGroup({ capacity: 900 });
 * var c = new charts.TimeSeriesChart({
 *     group: g,
 *     series: [ { key:'dl_sh', label:'DL shaper', color:'#2266cc', width:2 },
 *               { key:'dl_ac', label:'DL achieved', color:'#2266cc', fill:'rgba(34,102,204,.15)' } ],
 *     guides: [ { value:60, label:'delay thr', color:'#cc0000' } ],
 *     height: 140, fmt: api.fmtKbps
 * });
 * parent.appendChild(g.renderControls());
 * parent.appendChild(c.render());
 * g.tick(); c.push({ dl_sh: 250000, dl_ac: 41000 });   // once per poll
 */

var W = 600;            /* SVG user units across; stretched to the container */
var GUTTER = 64;        /* px left of the plot reserved for y-axis labels */
var DASH = 6;           /* guide dash length; coinciding guides interleave */
var MIN_ZOOM_MS = 10000;
var GAP_MS = 10000;     /* a longer gap between samples breaks the line */
var svgNS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
	var el = document.createElementNS(svgNS, tag);
	for (var k in attrs)
		el.setAttribute(k, attrs[k]);
	return el;
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function fmtClock(ms) {
	var d = new Date(ms);
	return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/* Round up to a "nice" number (x 10^k) whose half is nice too, so the
 * grid labels stay readable without wasting much headroom. */
function niceMax(v) {
	if (!(v > 0)) return 1;
	var p = Math.pow(10, Math.floor(Math.log10(v))), steps = [ 1, 1.2, 1.6, 2, 3, 4, 5, 6, 8, 10 ];
	for (var i = 0; i < steps.length; i++)
		if (v <= steps[i] * p) return steps[i] * p;
	return 10 * p;
}

var ChartGroup = baseclass.extend({
	__init__: function(opts) {
		opts = opts || {};
		this.capacity = opts.capacity || 900;
		this.ranges = opts.ranges || [ 60, 300, 600, 1800 ];
		this.rangeS = opts.defaultRange || 600;
		this.t = null;          /* time of the current tick */
		this.zoom = null;       /* { t0, t1 } while zoomed, else live */
		this.charts = [];
		this.rangeButtons = [];
	},

	add: function(chart) { this.charts.push(chart); },

	remove: function(chart) {
		this.charts = this.charts.filter(function(c) { return c !== chart; });
	},

	tick: function() { this.t = Date.now(); },

	view: function() {
		if (this.zoom) return this.zoom;
		var t1 = this.t || Date.now();
		return { t0: t1 - this.rangeS * 1000, t1: t1 };
	},

	redraw: function() {
		this.charts.forEach(function(c) { c.redraw(); });
		this.updateControls();
	},

	setRange: function(s) {
		this.rangeS = s;
		this.zoom = null;
		this.redraw();
	},

	setZoom: function(t0, t1) {
		if (t1 - t0 < MIN_ZOOM_MS) {
			var mid = (t0 + t1) / 2;
			t0 = mid - MIN_ZOOM_MS / 2;
			t1 = mid + MIN_ZOOM_MS / 2;
		}
		this.zoom = { t0: t0, t1: t1 };
		this.redraw();
	},

	reset: function() {
		this.zoom = null;
		this.redraw();
	},

	hover: function(t) {
		this.charts.forEach(function(c) { c.showHover(t); });
	},

	renderControls: function() {
		var self = this;
		this.rangeButtons = this.ranges.map(function(s) {
			var b = E('button', {
				'type': 'button',
				'class': 'btn cbi-button',
				'style': 'padding:0 8px;min-width:0',
				'click': function() { self.setRange(s); }
			}, s < 60 ? s + _('s') : (s / 60) + _('m'));
			b.rangeS = s;
			return b;
		});
		this.liveButton = E('button', {
			'type': 'button',
			'class': 'btn cbi-button cbi-button-action',
			'style': 'padding:0 8px;display:none',
			'click': function() { self.reset(); }
		}, _('Back to live'));
		this.zoomLabel = E('span', { 'style': 'color:#555' }, '');
		this.hint = E('span', { 'style': 'color:#999;font-size:11px' },
			_('Drag across a chart to zoom in, double-click to zoom out.'));
		this.updateControls();
		return E('div', { 'style': 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:10px 0 2px;font-size:12px' },
			[ E('span', {}, _('Time range') + ':') ].concat(this.rangeButtons, [ this.zoomLabel, this.liveButton, this.hint ]));
	},

	updateControls: function() {
		var self = this;
		if (!this.liveButton) return;
		this.rangeButtons.forEach(function(b) {
			b.style.fontWeight = (!self.zoom && b.rangeS === self.rangeS) ? 'bold' : '';
			b.style.textDecoration = (!self.zoom && b.rangeS === self.rangeS) ? 'underline' : '';
		});
		this.liveButton.style.display = this.zoom ? '' : 'none';
		this.hint.style.display = this.zoom ? 'none' : '';
		this.zoomLabel.textContent = this.zoom
			? _('Zoomed: %s – %s').format(fmtClock(this.zoom.t0), fmtClock(this.zoom.t1)) : '';
	}
});

var TimeSeriesChart = baseclass.extend({
	__init__: function(opts) {
		this.opts = opts || {};
		this.group = this.opts.group || new ChartGroup({ capacity: this.opts.samples });
		this.group.add(this);
		this.series = this.opts.series || [];
		this.guides = this.opts.guides || [];
		this.h = this.opts.height || 140;
		this.fmt = this.opts.fmt || this.opts.fmtMax || function(v) { return String(Math.round(v)); };
		this.times = [];
		this.data = {};
		for (var i = 0; i < this.series.length; i++)
			this.data[this.series[i].key] = [];
	},

	push: function(sample) {
		var cap = this.group.capacity;
		this.times.push(this.group.t || Date.now());
		for (var i = 0; i < this.series.length; i++) {
			var k = this.series[i].key, v = sample[k];
			this.data[k].push((v == null || isNaN(v)) ? null : Number(v));
			if (this.data[k].length > cap) this.data[k].shift();
		}
		if (this.times.length > cap) this.times.shift();
		this.redraw();
	},

	/* Replace the guide lines (e.g. thresholds changed after a config edit);
	 * the legend is rebuilt only when labels/values actually changed. */
	setGuides: function(guides) {
		var sig = JSON.stringify(guides);
		if (sig === this.guidesSig) return;
		this.guidesSig = sig;
		this.guides = guides;
		if (this.svg) {
			this.buildGuideLines();
			this.renderLegend();
			this.redraw();
		}
	},

	destroy: function() {
		this.group.remove(this);
		if (this.root && this.root.parentNode)
			this.root.parentNode.removeChild(this.root);
	},

	/* Index range [lo, hi] of samples to draw: everything inside the view
	 * plus one neighbour on each side so lines run to the plot edges. */
	visibleRange: function(v) {
		var n = this.times.length, lo = 0, hi = n - 1;
		while (lo < n && this.times[lo] < v.t0) lo++;
		while (hi >= 0 && this.times[hi] > v.t1) hi--;
		return { lo: Math.max(0, lo - 1), hi: Math.min(n - 1, hi + 1), inLo: lo, inHi: hi };
	},

	scaleMax: function(v, r) {
		var m = 0, i, j, s, arr;
		for (i = 0; i < this.series.length; i++) {
			s = this.series[i];
			if (s.hidden) continue;
			arr = this.data[s.key];
			for (j = r.inLo; j <= r.inHi; j++)
				if (arr[j] != null && arr[j] > m) m = arr[j];
		}
		/* Live: keep thresholds in view for context. Zoomed: scale to the
		 * data alone so small values (idle traffic, low latency) are legible. */
		if (!this.group.zoom)
			for (i = 0; i < this.guides.length; i++)
				if (this.guides[i].value > m) m = this.guides[i].value;
		return niceMax(m * 1.05);
	},

	x: function(t, v) { return (t - v.t0) / (v.t1 - v.t0) * W; },
	y: function(val, max) { return this.h - (val / max) * this.h; },

	path: function(key, v, r, max, close) {
		var arr = this.data[key], d = '', segStart = null, lastT = null, i, x, px = null;
		for (i = r.lo; i <= r.hi; i++) {
			if (arr[i] == null || (lastT != null && this.times[i] - lastT > GAP_MS)) {
				if (close && segStart != null) d += 'L' + px + ' ' + this.h + 'L' + segStart + ' ' + this.h + 'Z';
				segStart = null;
				if (arr[i] == null) { lastT = null; continue; }
			}
			x = this.x(this.times[i], v).toFixed(1);
			d += (segStart == null ? 'M' : 'L') + x + ' ' + this.y(arr[i], max).toFixed(1);
			if (segStart == null) segStart = x;
			px = x;
			lastT = this.times[i];
		}
		if (close && segStart != null) d += 'L' + px + ' ' + this.h + 'L' + segStart + ' ' + this.h + 'Z';
		return d;
	},

	redraw: function() {
		if (!this.svg) return;
		var v = this.group.view(), r = this.visibleRange(v), max = this.scaleMax(v, r), i, s;
		this.max = max;

		for (i = 0; i < this.series.length; i++) {
			s = this.series[i];
			var el = this.paths[s.key];
			el.setAttribute('d', s.hidden ? '' : this.path(s.key, v, r, max, false));
			if (s.fill)
				this.fills[s.key].setAttribute('d', s.hidden ? '' : this.path(s.key, v, r, max, true));
		}

		/* Guides that land on the same pixel row interleave their dashes
		 * (red-orange-red-orange...) instead of one hiding the other. */
		var rows = [];
		for (i = 0; i < this.guides.length; i++) {
			var g = this.guides[i], line = this.guideLines[i], gy = this.y(g.value, max);
			if (g.value == null || g.value > max) { line.style.display = 'none'; continue; }
			line.style.display = '';
			line.setAttribute('y1', gy.toFixed(1));
			line.setAttribute('y2', gy.toFixed(1));
			var row = null;
			for (var j = 0; j < rows.length; j++)
				if (Math.abs(rows[j].y - gy) < 1.5) { row = rows[j]; break; }
			if (!row) rows.push(row = { y: gy, lines: [] });
			row.lines.push(line);
		}
		rows.forEach(function(rw) {
			var k = rw.lines.length;
			rw.lines.forEach(function(line, idx) {
				line.setAttribute('stroke-dasharray', k > 1 ? DASH + ' ' + (DASH * (k - 1)) : DASH + ' 4');
				line.setAttribute('stroke-dashoffset', k > 1 ? -DASH * idx : 0);
			});
		});

		this.yLabels[0].textContent = this.fmt(max);
		this.yLabels[1].textContent = this.fmt(max / 2);
		this.yLabels[2].textContent = this.fmt(0);
		this.xLabels[0].textContent = fmtClock(v.t0);
		this.xLabels[1].textContent = this.group.zoom ? fmtClock(v.t1) : _('now');

		if (this.hoverT != null) this.showHover(this.hoverT);
	},

	/* Nearest sample to time t (within the view), or -1. */
	nearest: function(t) {
		var v = this.group.view(), best = -1, bd = Infinity;
		for (var i = 0; i < this.times.length; i++) {
			if (this.times[i] < v.t0 || this.times[i] > v.t1) continue;
			var d = Math.abs(this.times[i] - t);
			if (d < bd) { bd = d; best = i; }
		}
		return best;
	},

	showHover: function(t) {
		this.hoverT = t;
		if (!this.svg) return;
		var i = (t == null) ? -1 : this.nearest(t);
		if (i < 0) {
			this.hoverLine.style.display = 'none';
			this.tip.style.display = 'none';
			return;
		}
		var v = this.group.view(), x = this.x(this.times[i], v);
		this.hoverLine.setAttribute('x1', x.toFixed(1));
		this.hoverLine.setAttribute('x2', x.toFixed(1));
		this.hoverLine.style.display = '';

		var self = this, rows = [ E('div', { 'style': 'color:#666;margin-bottom:2px' }, fmtClock(this.times[i])) ];
		this.series.forEach(function(s) {
			if (s.hidden) return;
			var val = self.data[s.key][i];
			rows.push(E('div', {}, [
				E('span', { 'style': 'display:inline-block;width:8px;height:8px;margin-right:4px;background:' + s.color }),
				s.label + ': ',
				E('strong', {}, val == null ? '-' : self.fmt(val))
			]));
		});
		dom.content(this.tip, rows);
		this.tip.style.display = '';
		var frac = x / W, pw = this.plot.clientWidth;
		if (frac > 0.6) {
			this.tip.style.left = '';
			this.tip.style.right = Math.max(0, (1 - frac) * pw + 8) + 'px';
		} else {
			this.tip.style.right = '';
			this.tip.style.left = Math.max(0, frac * pw + 8) + 'px';
		}
	},

	buildGuideLines: function() {
		(this.guideLines || []).forEach(function(l) { l.parentNode && l.parentNode.removeChild(l); });
		this.guideLines = [];
		for (var i = 0; i < this.guides.length; i++) {
			var line = svgEl('line', {
				'x1': 0, 'x2': W, 'y1': -10, 'y2': -10,
				'stroke': this.guides[i].color, 'stroke-width': 1.5,
				'vector-effect': 'non-scaling-stroke'
			});
			this.svg.insertBefore(line, this.hoverLine);
			this.guideLines.push(line);
		}
	},

	renderLegend: function() {
		var self = this, items = [];
		this.series.forEach(function(s) {
			var item = E('span', {
				'style': 'margin-right:12px;cursor:pointer;user-select:none;opacity:' + (s.hidden ? '.35' : '1'),
				'title': _('Click to show/hide'),
				'click': function() {
					s.hidden = !s.hidden;
					item.style.opacity = s.hidden ? '.35' : '1';
					self.redraw();
				}
			}, [
				E('span', { 'style': 'display:inline-block;width:10px;height:3px;background:' + s.color + ';vertical-align:middle;margin-right:4px' }),
				s.label
			]);
			items.push(item);
		});
		this.guides.forEach(function(g) {
			items.push(E('span', { 'style': 'margin-right:12px' }, [
				E('span', { 'style': 'display:inline-block;width:10px;height:0;border-top:2px dashed ' + g.color + ';vertical-align:middle;margin-right:4px' }),
				g.label + (g.value != null ? ' (' + self.fmt(g.value) + ')' : '')
			]));
		});
		dom.content(this.legend, items);
	},

	render: function() {
		var self = this, h = this.h, i, s;

		this.svg = svgEl('svg', {
			'viewBox': '0 0 ' + W + ' ' + h,
			'preserveAspectRatio': 'none',
			'style': 'display:block;width:100%;height:' + h + 'px;background:#fafafa;border:1px solid #ddd;border-radius:3px;cursor:crosshair'
		});
		[ 0, 0.5 ].forEach(function(f) {
			self.svg.appendChild(svgEl('line', {
				'x1': 0, 'x2': W, 'y1': (h * f).toFixed(1), 'y2': (h * f).toFixed(1),
				'stroke': '#e4e4e4', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke'
			}));
		});

		this.paths = {};
		this.fills = {};
		for (i = 0; i < this.series.length; i++) {
			s = this.series[i];
			if (s.fill) {
				this.fills[s.key] = svgEl('path', { 'fill': s.fill, 'stroke': 'none' });
				this.svg.appendChild(this.fills[s.key]);
			}
		}
		for (i = 0; i < this.series.length; i++) {
			s = this.series[i];
			this.paths[s.key] = svgEl('path', {
				'fill': 'none', 'stroke': s.color,
				'stroke-width': s.width || 1,
				'stroke-opacity': s.fill ? 0.6 : 1,
				'stroke-linejoin': 'round',
				'vector-effect': 'non-scaling-stroke'
			});
			this.svg.appendChild(this.paths[s.key]);
		}

		this.hoverLine = svgEl('line', {
			'x1': 0, 'x2': 0, 'y1': 0, 'y2': h, 'stroke': '#555', 'stroke-width': 1,
			'vector-effect': 'non-scaling-stroke', 'style': 'display:none'
		});
		this.svg.appendChild(this.hoverLine);
		this.selRect = svgEl('rect', {
			'x': 0, 'y': 0, 'width': 0, 'height': h,
			'fill': 'rgba(34,102,204,.12)', 'stroke': 'rgba(34,102,204,.5)',
			'vector-effect': 'non-scaling-stroke', 'style': 'display:none'
		});
		this.svg.appendChild(this.selRect);
		this.buildGuideLines();

		this.tip = E('div', {
			'style': 'display:none;position:absolute;top:4px;pointer-events:none;background:rgba(255,255,255,.95);' +
				'border:1px solid #ccc;border-radius:3px;padding:4px 6px;font-size:11px;line-height:1.4;white-space:nowrap;z-index:5'
		});
		this.plot = E('div', { 'style': 'position:relative;flex:1;min-width:0' }, [ this.svg, this.tip ]);

		var lblStyle = 'position:absolute;right:6px;font-size:11px;color:#999;white-space:nowrap;line-height:1';
		this.yLabels = [
			E('span', { 'style': lblStyle + ';top:0' }, ''),
			E('span', { 'style': lblStyle + ';top:' + (h / 2 - 5) + 'px' }, ''),
			E('span', { 'style': lblStyle + ';bottom:0' }, '')
		];
		var gutter = E('div', { 'style': 'position:relative;flex:0 0 ' + GUTTER + 'px;height:' + (h + 2) + 'px' }, this.yLabels);

		this.xLabels = [ E('span', {}, ''), E('span', {}, '') ];
		var xAxis = E('div', { 'style': 'margin-left:' + GUTTER + 'px;display:flex;justify-content:space-between;font-size:11px;color:#999' }, this.xLabels);

		this.legend = E('div', { 'style': 'margin-left:' + GUTTER + 'px;font-size:11px;color:#555;margin-top:2px' });
		this.renderLegend();

		/* Mouse: hover shows values on every chart of the group; drag
		 * selects a time span to zoom into; double-click returns to live. */
		var drag = null;
		function timeAt(ev) {
			var rect = self.svg.getBoundingClientRect(), v = self.group.view();
			var frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
			return { frac: frac, t: v.t0 + frac * (v.t1 - v.t0) };
		}
		this.svg.addEventListener('mousedown', function(ev) {
			if (ev.button !== 0) return;
			ev.preventDefault();
			drag = timeAt(ev);
		});
		this.svg.addEventListener('mousemove', function(ev) {
			var p = timeAt(ev);
			self.group.hover(p.t);
			if (drag) {
				var a = Math.min(drag.frac, p.frac), b = Math.max(drag.frac, p.frac);
				self.selRect.setAttribute('x', (a * W).toFixed(1));
				self.selRect.setAttribute('width', ((b - a) * W).toFixed(1));
				self.selRect.style.display = '';
			}
		});
		this.svg.addEventListener('mouseup', function(ev) {
			if (!drag) return;
			var p = timeAt(ev), start = drag;
			drag = null;
			self.selRect.style.display = 'none';
			if (Math.abs(p.frac - start.frac) * self.svg.getBoundingClientRect().width > 6)
				self.group.setZoom(Math.min(start.t, p.t), Math.max(start.t, p.t));
		});
		this.svg.addEventListener('mouseleave', function() {
			drag = null;
			self.selRect.style.display = 'none';
			self.group.hover(null);
		});
		this.svg.addEventListener('dblclick', function(ev) {
			ev.preventDefault();
			self.group.reset();
		});
		/* Touch: tap/slide shows values (zoom via the range buttons). */
		this.svg.addEventListener('touchstart', function(ev) {
			if (ev.touches.length === 1) self.group.hover(timeAt(ev.touches[0]).t);
		}, { passive: true });
		this.svg.addEventListener('touchmove', function(ev) {
			if (ev.touches.length === 1) self.group.hover(timeAt(ev.touches[0]).t);
		}, { passive: true });

		this.root = E('div', { 'style': 'margin:6px 0' }, [
			E('div', { 'style': 'display:flex' }, [ gutter, this.plot ]),
			xAxis,
			this.legend
		]);
		this.redraw();
		return this.root;
	}
});

return baseclass.extend({
	ChartGroup: ChartGroup,
	TimeSeriesChart: TimeSeriesChart
});
