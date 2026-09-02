'use strict';
'require baseclass';
'require dom';

/*
 * TimeSeriesChart -- rolling inline-SVG line/area chart, no dependencies.
 *
 * var c = new charts.TimeSeriesChart({
 *     series: [ { key:'dl_sh', label:'DL shaper', color:'#2266cc', width:2 },
 *               { key:'dl_ac', label:'DL achieved', color:'#2266cc', fill:'rgba(34,102,204,.15)' } ],
 *     guides: [ { value:60, label:'delay thr', color:'#cc0000', dash:'4 3' } ],
 *     height: 140, samples: 300, unit: 'ms', min: 0
 * });
 * parent.appendChild(c.render());
 * c.push({ dl_sh: 250000, dl_ac: 41000 });      // one sample per poll tick
 */
var W = 600;

return baseclass.extend({
	TimeSeriesChart: baseclass.extend({
		__init__: function(opts) {
			this.opts = opts || {};
			this.series = this.opts.series || [];
			this.guides = this.opts.guides || [];
			this.n = this.opts.samples || 300;
			this.h = this.opts.height || 140;
			this.data = {};
			for (var i = 0; i < this.series.length; i++)
				this.data[this.series[i].key] = [];
		},

		push: function(sample) {
			for (var i = 0; i < this.series.length; i++) {
				var k = this.series[i].key,
				    v = sample[k];
				this.data[k].push((v == null || isNaN(v)) ? null : Number(v));
				if (this.data[k].length > this.n)
					this.data[k].shift();
			}
			this.redraw();
		},

		maxValue: function() {
			var m = 0, i, j, arr;
			for (i = 0; i < this.series.length; i++) {
				arr = this.data[this.series[i].key];
				for (j = 0; j < arr.length; j++)
					if (arr[j] != null && arr[j] > m) m = arr[j];
			}
			for (i = 0; i < this.guides.length; i++)
				if (this.guides[i].value > m) m = this.guides[i].value;
			return m > 0 ? m * 1.1 : 1;
		},

		path: function(arr, max, close) {
			var step = W / (this.n - 1), d = '', started = false, i, x, y;
			for (i = 0; i < arr.length; i++) {
				if (arr[i] == null) continue;
				x = (this.n - arr.length + i) * step;
				y = this.h - (arr[i] / max) * this.h;
				d += (started ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
				started = true;
			}
			if (close && started) {
				d += 'L' + W + ' ' + this.h + 'L' + ((this.n - arr.length) * step).toFixed(1) + ' ' + this.h + 'Z';
			}
			return d;
		},

		redraw: function() {
			if (!this.svg) return;
			var max = this.maxValue(), i, s, el;
			for (i = 0; i < this.series.length; i++) {
				s = this.series[i];
				el = this.svg.querySelector('[data-key="' + s.key + '"]');
				if (el) el.setAttribute('d', this.path(this.data[s.key], max, !!s.fill));
			}
			for (i = 0; i < this.guides.length; i++) {
				el = this.svg.querySelector('[data-guide="' + i + '"]');
				if (el) {
					var gy = this.h - (this.guides[i].value / max) * this.h;
					el.setAttribute('y1', gy.toFixed(1));
					el.setAttribute('y2', gy.toFixed(1));
				}
			}
			if (this.maxLabel)
				this.maxLabel.textContent = this.opts.fmtMax ? this.opts.fmtMax(max) : String(Math.round(max));
		},

		render: function() {
			var svgNS = 'http://www.w3.org/2000/svg', i, s, p, g;
			this.svg = document.createElementNS(svgNS, 'svg');
			this.svg.setAttribute('viewBox', '0 0 ' + W + ' ' + this.h);
			this.svg.setAttribute('preserveAspectRatio', 'none');
			this.svg.setAttribute('style', 'width:100%;height:' + this.h + 'px;background:#fafafa;border:1px solid #ddd;border-radius:3px');
			for (i = 0; i < this.series.length; i++) {
				s = this.series[i];
				p = document.createElementNS(svgNS, 'path');
				p.setAttribute('data-key', s.key);
				p.setAttribute('fill', s.fill || 'none');
				p.setAttribute('stroke', s.fill ? 'none' : s.color);
				p.setAttribute('stroke-width', s.width || 1.5);
				this.svg.appendChild(p);
			}
			for (i = 0; i < this.guides.length; i++) {
				g = document.createElementNS(svgNS, 'line');
				g.setAttribute('data-guide', i);
				g.setAttribute('x1', 0); g.setAttribute('x2', W);
				g.setAttribute('stroke', this.guides[i].color);
				g.setAttribute('stroke-dasharray', this.guides[i].dash || '4 3');
				g.setAttribute('stroke-width', 1);
				this.svg.appendChild(g);
			}
			this.maxLabel = E('span', { 'style': 'position:absolute;top:2px;right:6px;font-size:11px;color:#999' }, '');
			var legend = E('div', { 'style': 'font-size:11px;color:#555;margin-top:2px' },
				this.series.concat(this.guides).map(L.bind(function(s2) {
					return E('span', { 'style': 'margin-right:12px' }, [
						E('span', { 'style': 'display:inline-block;width:10px;height:3px;background:' + (s2.color || '#000') + ';vertical-align:middle;margin-right:4px' }),
						s2.label || ''
					]);
				}, this)));
			return E('div', { 'style': 'position:relative;margin:6px 0' }, [ this.svg, this.maxLabel, legend ]);
		}
	})
});
