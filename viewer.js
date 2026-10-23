/* Fairest Heart EDF / EDF+ viewer. Plain JavaScript, no dependencies.
   The file is read in this page with the File API. Nothing is uploaded.
   It only DISPLAYS the file: no analysis of any kind. Calipers are manual. */
(function (root) {
  'use strict';

  /* ================================================================ parser */

  function EdfError(message) { this.name = 'EdfError'; this.message = message; }
  EdfError.prototype = Object.create(Error.prototype);

  function asciiField(u8, off, len) {
    var s = '';
    for (var i = 0; i < len; i++) s += String.fromCharCode(u8[off + i]);
    return s;
  }
  function numField(u8, off, len) { return parseFloat(asciiField(u8, off, len).trim()); }
  function utf8(u8, a, b) {
    var sub = u8.subarray(a, b);
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(sub);
    var s = ''; for (var i = 0; i < sub.length; i++) s += String.fromCharCode(sub[i]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }

  var MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

  /* Start of the recording as a "nominal wall clock" in ms (UTC arithmetic so
     time zones and daylight saving never shift it), or null. */
  function parseStartMs(dateStr, timeStr, recording) {
    var y, mo, d;
    var m = /Startdate\s+(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(recording || '');
    var dm = /^(\d\d)\.(\d\d)\.(\d\d)$/.exec(dateStr);
    var tm = /^(\d\d)\.(\d\d)\.(\d\d)$/.exec(timeStr);
    if (!tm) return null;
    if (m && MONTHS[m[2].toUpperCase()] !== undefined) {
      d = +m[1]; mo = MONTHS[m[2].toUpperCase()]; y = +m[3];
    } else if (dm) {
      d = +dm[1]; mo = +dm[2] - 1; var yy = +dm[3]; y = yy >= 85 ? 1900 + yy : 2000 + yy;
    } else return null;
    return Date.UTC(y, mo, d, +tm[1], +tm[2], +tm[3]);
  }

  /* Time-stamped annotation lists. Returns one entry per non-empty text:
     [{onsetS, durationS, text}]. Timekeeping TALs (empty text) are dropped. */
  function parseTalsRaw(bytes) {
    var out = [], i = 0, n = bytes.length;
    while (i < n) {
      if (bytes[i] === 0) { i++; continue; }
      var j = i; while (j < n && bytes[j] !== 0) j++;
      var k = i; while (k < j && bytes[k] !== 0x14) k++;
      if (k < j) {
        var head = utf8(bytes, i, k), dur = NaN, onset;
        var p = head.indexOf('\x15');
        if (p >= 0) { dur = parseFloat(head.slice(p + 1)); head = head.slice(0, p); }
        onset = parseFloat(head);
        if (!isNaN(onset)) {
          var texts = [], pos = k + 1;
          while (pos < j) {
            var e = pos; while (e < j && bytes[e] !== 0x14) e++;
            if (e > pos) texts.push(utf8(bytes, pos, e));
            pos = e + 1;
          }
          out.push({ onsetS: onset, durationS: isNaN(dur) ? 0 : dur, texts: texts });
        }
      }
      i = j + 1;
    }
    return out;
  }
  function parseTals(bytes) {
    var raw = parseTalsRaw(bytes), out = [];
    raw.forEach(function (t) {
      t.texts.forEach(function (x) { out.push({ onsetS: t.onsetS, durationS: t.durationS, text: x }); });
    });
    return out;
  }

  function unitFactorToMv(dim) {
    var d = String(dim || '').trim().toLowerCase().replace('µ', 'u');
    if (d === 'mv') return 1;
    if (d === 'v') return 1000;
    return 0.001; // uV and anything unknown
  }

  function parseEdf(buffer) {
    var u8 = new Uint8Array(buffer);
    if (u8.length < 256) throw new EdfError('This is too small to be an EDF file.');
    if (asciiField(u8, 0, 8) !== '0       ') throw new EdfError('This does not look like an EDF file. Files from Fairest Heart end in .edf.');
    var ns = numField(u8, 252, 4);
    if (!(ns >= 1 && ns <= 1024)) throw new EdfError('The file header is damaged (number of signals).');
    var headerBytes = numField(u8, 184, 8);
    if (!(headerBytes >= 256 + ns * 256)) headerBytes = 256 + ns * 256;
    if (u8.length < 256 + ns * 256) throw new EdfError('The file ends inside its header.');
    var recordDur = numField(u8, 244, 8);
    if (!(recordDur > 0)) recordDur = 1;
    var declared = numField(u8, 236, 8);
    if (isNaN(declared)) declared = -1;

    var reserved = asciiField(u8, 192, 44).trim();
    var kind = /^EDF\+C/.test(reserved) ? 'EDF+C' : /^EDF\+D/.test(reserved) ? 'EDF+D' : 'EDF';
    var header = {
      version: asciiField(u8, 0, 8).trim(),
      patient: asciiField(u8, 8, 80).trim(),
      recording: asciiField(u8, 88, 80).trim(),
      startDate: asciiField(u8, 168, 8).trim(),
      startTime: asciiField(u8, 176, 8).trim(),
      headerBytes: headerBytes,
      reserved: reserved,
      kind: kind,
      numSignals: ns
    };
    header.startMs = parseStartMs(header.startDate, header.startTime, header.recording);

    var signals = [], base = 256, off = 0, i;
    function col(width, idx) { return asciiField(u8, base + idx * width, width).trim(); }
    var cLabel = base, cTrans = cLabel + ns * 16, cDim = cTrans + ns * 80, cPmin = cDim + ns * 8,
        cPmax = cPmin + ns * 8, cDmin = cPmax + ns * 8, cDmax = cDmin + ns * 8, cPre = cDmax + ns * 8,
        cSpr = cPre + ns * 80;
    for (i = 0; i < ns; i++) {
      var spr = numField(u8, cSpr + i * 8, 8);
      if (!(spr >= 0)) spr = 0;
      var label = asciiField(u8, cLabel + i * 16, 16).trim();
      signals.push({
        label: label,
        transducer: asciiField(u8, cTrans + i * 80, 80).trim(),
        dim: asciiField(u8, cDim + i * 8, 8).trim(),
        pmin: numField(u8, cPmin + i * 8, 8),
        pmax: numField(u8, cPmax + i * 8, 8),
        dmin: numField(u8, cDmin + i * 8, 8),
        dmax: numField(u8, cDmax + i * 8, 8),
        prefilter: asciiField(u8, cPre + i * 80, 80).trim(),
        samplesPerRecord: spr,
        rate: spr / recordDur,
        offsetInRecord: off,
        isAnnotations: /^EDF Annotations/i.test(label)
      });
      off += spr;
    }
    var recBytes = off * 2;
    if (recBytes <= 0) throw new EdfError('The file has no sample data.');
    var whole = Math.floor((u8.length - headerBytes) / recBytes);
    if (whole < 0) whole = 0;
    var records = declared >= 0 ? Math.min(declared, whole) : whole;
    var truncated = declared >= 0 ? records < declared : (u8.length - headerBytes) % recBytes !== 0;

    // Annotations and record start times (EDF+).
    var annotations = [], recordOnsets = null, contiguous = true;
    var annSigs = signals.filter(function (s) { return s.isAnnotations; });
    if (annSigs.length) {
      var onsets = new Float64Array(records);
      for (var r = 0; r < records; r++) {
        var rb = headerBytes + r * recBytes, gotOnset = false;
        for (var a = 0; a < annSigs.length; a++) {
          var sg = annSigs[a];
          var bytes = u8.subarray(rb + sg.offsetInRecord * 2, rb + (sg.offsetInRecord + sg.samplesPerRecord) * 2);
          var tals = parseTalsRaw(bytes);
          for (var q = 0; q < tals.length; q++) {
            var t = tals[q];
            if (!gotOnset && a === 0 && q === 0 && t.texts.length === 0) { onsets[r] = t.onsetS; gotOnset = true; continue; }
            t.texts.forEach(function (x) { annotations.push({ onsetS: t.onsetS, durationS: t.durationS, text: x }); });
          }
        }
        if (!gotOnset) onsets[r] = r * recordDur;
        if (Math.abs(onsets[r] - r * recordDur) > 1e-4) contiguous = false;
      }
      if (!contiguous) recordOnsets = onsets;
      annotations.sort(function (x, y) { return x.onsetS - y.onsetS; });
    }

    return {
      header: header, signals: signals, records: records, declaredRecords: declared,
      recordDurationS: recordDur, annotations: annotations, recordOnsets: recordOnsets,
      truncated: truncated, buffer: buffer, dataStart: headerBytes, recBytes: recBytes,
      durationS: recordOnsets && records ? recordOnsets[records - 1] + recordDur : records * recordDur
    };
  }

  function channelLength(parsed, index) {
    var sg = parsed.signals[index];
    if (!parsed.recordOnsets) return parsed.records * sg.samplesPerRecord;
    var n = Math.ceil((parsed.recordOnsets[parsed.records - 1] + parsed.recordDurationS) * sg.rate);
    if (n > 400e6) throw new EdfError('The file has gaps too long to lay out on screen.');
    return n;
  }

  function fillChannel(parsed, index, out, r0, r1) {
    var sg = parsed.signals[index];
    var dv = new DataView(parsed.buffer);
    var spr = sg.samplesPerRecord;
    var span = sg.dmax - sg.dmin;
    var scale = span !== 0 ? (sg.pmax - sg.pmin) / span : 1;
    var unit = unitFactorToMv(sg.dim);
    var k = scale * unit, c0 = sg.dmin, p0 = sg.pmin * unit;
    for (var r = r0; r < r1; r++) {
      var pos = parsed.dataStart + r * parsed.recBytes + sg.offsetInRecord * 2;
      var o = parsed.recordOnsets ? Math.round(parsed.recordOnsets[r] * sg.rate) : r * spr;
      for (var j = 0; j < spr; j++, pos += 2) out[o + j] = (dv.getInt16(pos, true) - c0) * k + p0;
    }
  }

  /* One channel as Float32Array, in millivolts when the unit is uV / mV / V. */
  function extractChannel(parsed, index) {
    var out = new Float32Array(channelLength(parsed, index));
    if (parsed.recordOnsets) out.fill(NaN);
    fillChannel(parsed, index, out, 0, parsed.records);
    return out;
  }

  /* Same, in slices so a big file never freezes the tab. */
  function extractChannelAsync(parsed, index, onProgress) {
    return new Promise(function (resolve, reject) {
      var out;
      try {
        out = new Float32Array(channelLength(parsed, index));
        if (parsed.recordOnsets) out.fill(NaN);
      } catch (e) { reject(e); return; }
      var spr = parsed.signals[index].samplesPerRecord || 1;
      var step = Math.max(1, Math.floor(1500000 / spr)), r = 0;
      (function slice() {
        try {
          var end = Math.min(parsed.records, r + step);
          fillChannel(parsed, index, out, r, end);
          r = end;
        } catch (e) { reject(e); return; }
        if (onProgress) onProgress(parsed.records ? r / parsed.records : 1);
        if (r >= parsed.records) resolve(out); else setTimeout(slice, 0);
      })();
    });
  }

  function pickEcg(signals) {
    var first = -1;
    for (var i = 0; i < signals.length; i++) {
      if (signals[i].isAnnotations) continue;
      if (first < 0) first = i;
      if (/ecg/i.test(signals[i].label)) return { index: i, found: true };
    }
    return { index: first, found: false };
  }

  /* ================================================================ drawing */

  var DARK = { bg: '#0d1118', minor: 'rgba(154,163,178,0.10)', major: 'rgba(154,163,178,0.26)',
               trace: '#5fe3c8', mark: '#fbbf24', cal: '#b9a6ff', text: '#9aa3b2' };
  var PAPER = { bg: '#ffffff', minor: '#f7d3d6', major: '#eba2a9',
                trace: '#111111', mark: '#a35a07', cal: '#1d4ed8', text: '#444444' };
  var STRIP_MM = 50;      // canvas height: +-2.5 mV at 10 mm/mV
  var MONO = 'ui-monospace, Menlo, Consolas, "Roboto Mono", monospace';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtOffset(t, dec, forceHours) {
    if (t < 0) return '-' + fmtOffset(-t, dec, forceHours);
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    var ss = dec ? (s < 10 ? '0' : '') + s.toFixed(dec) : pad2(Math.floor(s));
    return (h > 0 || forceHours) ? h + ':' + pad2(m) + ':' + ss : m + ':' + ss;
  }
  function fmtStamp(ms, withDate) {
    var d = new Date(ms);
    var time = pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
    if (!withDate) return time;
    return DAYS[d.getUTCDay()] + ' ' + pad2(d.getUTCDate()) + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' ' + time;
  }
  function fmtDuration(sec) {
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60, p = [];
    if (h) p.push(h + ' h'); if (h || m) p.push(m + ' min'); p.push(s + ' s');
    return p.join(' ');
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' bytes';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /* Draw one strip. g: {W,H,ppm (device px per mm), startS, speed (mm/s), gain (mm/mV),
     paper, ecg, rate, marks:[{t,text}], cal:[t,t], dpr, fs (font px), traceW,
     lineMinor, lineMajor, totalS} */
  function drawStrip(ctx, g) {
    var W = g.W, H = g.H, ppm = g.ppm, pal = g.paper ? PAPER : DARK, sp = g.speed, i;
    var x0mm = g.startS * sp, yc = H / 2, spanS = W / (ppm * sp);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H);

    // grid: 1 mm minor, 5 mm major, anchored to time zero so it travels with the trace
    function gridPass(major, lw, color) {
      var o = (lw % 2) / 2;
      ctx.beginPath(); ctx.lineWidth = lw; ctx.strokeStyle = color;
      var m, x, y;
      for (m = Math.floor(x0mm); m <= Math.ceil(x0mm + W / ppm); m++) {
        if ((((m % 5) + 5) % 5 === 0) !== major) continue;
        x = Math.round((m - x0mm) * ppm) + o; ctx.moveTo(x, 0); ctx.lineTo(x, H);
      }
      var nmax = Math.floor(yc / ppm);
      for (m = -nmax; m <= nmax; m++) {
        if ((((m % 5) + 5) % 5 === 0) !== major) continue;
        y = Math.round(yc + m * ppm) + o; ctx.moveTo(0, y); ctx.lineTo(W, y);
      }
      ctx.stroke();
    }
    gridPass(false, g.lineMinor, pal.minor);
    gridPass(true, g.lineMajor, pal.major);

    // whole-second labels
    ctx.font = g.fs + 'px ' + MONO; ctx.fillStyle = pal.text; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    var forceH = g.totalS >= 3600;
    for (i = Math.ceil(g.startS); i <= g.startS + spanS; i++) {
      var tx = Math.round((i * sp - x0mm) * ppm);
      ctx.fillText(fmtOffset(i, 0, forceH), tx + g.fs * 0.3, H - g.fs * 0.4);
    }
    ctx.fillText(sp + ' mm/s · ' + g.gain + ' mm/mV', g.fs * 0.5, g.fs * 1.2);

    // trace
    var d = g.ecg, rate = g.rate, gainPx = g.gain * ppm, k = sp * ppm / rate, xo = -x0mm * ppm;
    var iA = Math.max(0, Math.floor(g.startS * rate) - 1);
    var iB = Math.min(d.length - 1, Math.ceil((g.startS + spanS) * rate) + 1);
    ctx.beginPath(); ctx.lineWidth = g.traceW; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = pal.trace;
    var pen = false;
    for (i = iA; i <= iB; i++) {
      var v = d[i];
      if (v !== v) { pen = false; continue; }
      var y = yc - v * gainPx; if (y < 1) y = 1; else if (y > H - 1) y = H - 1;
      var x = xo + i * k;
      if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
    }
    ctx.stroke();

    // marks the wearer made
    var dpr = g.dpr || 1, dash = [4 * dpr, 4 * dpr];
    (g.marks || []).forEach(function (mk) {
      var mx = Math.round((mk.t * sp - x0mm) * ppm) + 0.5;
      if (mx < -400 * dpr || mx > W + 4) return;
      ctx.save();
      ctx.strokeStyle = pal.mark; ctx.lineWidth = Math.max(1, Math.round(dpr)); ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, H); ctx.stroke(); ctx.restore();
      var txt = mk.text.length > 48 ? mk.text.slice(0, 47) + '…' : mk.text;
      ctx.fillStyle = pal.mark; ctx.font = g.fs + 'px ' + MONO;
      var tw = ctx.measureText(txt).width;
      if (mx + g.fs * 0.4 + tw > W) { ctx.textAlign = 'right'; ctx.fillText(txt, mx - g.fs * 0.4, g.fs * 2.6); }
      else { ctx.textAlign = 'left'; ctx.fillText(txt, mx + g.fs * 0.4, g.fs * 2.6); }
      ctx.textAlign = 'left';
    });

    // calipers
    var cal = g.cal || [];
    if (cal.length) {
      var xs = cal.map(function (t) { return Math.round((t * sp - x0mm) * ppm) + 0.5; });
      ctx.strokeStyle = pal.cal; ctx.fillStyle = pal.cal; ctx.lineWidth = Math.max(1, Math.round(dpr * 1.2));
      xs.forEach(function (x) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); });
      if (xs.length === 2) {
        var ya = Math.round(H * 0.82) + 0.5;
        ctx.beginPath(); ctx.moveTo(xs[0], ya); ctx.lineTo(xs[1], ya); ctx.stroke();
        var ms = Math.abs(cal[1] - cal[0]) * 1000, label = Math.round(ms) + ' ms';
        ctx.font = g.fs + 'px ' + MONO; ctx.textAlign = 'center';
        ctx.fillText(label, (xs[0] + xs[1]) / 2, ya - g.fs * 0.4); ctx.textAlign = 'left';
      }
    }
  }

  function Renderer(canvas, ecg, rate, totalS) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.ecg = ecg; this.rate = rate; this.totalS = totalS;
    this.opts = { speed: 25, gain: 10, paper: false, marks: [], cal: [] };
    this.windowSec = 10; this.lastStart = 0;
    this.resize();
  }
  Renderer.prototype.resize = function () {
    var c = this.canvas, dpr = root.devicePixelRatio || 1;
    var cssW = Math.max(240, c.parentNode.clientWidth || c.clientWidth || 600);
    var base = cssW < 520 ? 3 : 4;                       // css px per mm on screen
    this.dpr = dpr;
    this.ppm = Math.max(2, Math.round(base * dpr));       // whole device px per mm: crisp grid
    c.width = Math.round(cssW * dpr);
    c.height = STRIP_MM * this.ppm;
    c.style.width = cssW + 'px';
    c.style.height = (c.height / dpr) + 'px';
    this.updateWindow();
  };
  Renderer.prototype.updateWindow = function () {
    this.windowSec = this.canvas.width / (this.ppm * this.opts.speed);
  };
  Renderer.prototype.maxStart = function () { return Math.max(0, this.totalS - this.windowSec); };
  Renderer.prototype.draw = function (windowStartS) {
    this.lastStart = windowStartS;
    var o = this.opts, dpr = this.dpr;
    drawStrip(this.ctx, {
      W: this.canvas.width, H: this.canvas.height, ppm: this.ppm, startS: windowStartS,
      speed: o.speed, gain: o.gain, paper: o.paper, ecg: this.ecg, rate: this.rate,
      marks: o.marks, cal: o.cal, dpr: dpr, fs: Math.round(11 * dpr), traceW: Math.max(1.25, 1.5 * dpr),
      lineMinor: 1, lineMajor: dpr >= 1.5 ? 2 : 1, totalS: this.totalS
    });
  };

  /* ================================================================ UI */

  function initUi() {
    var $ = function (id) { return document.getElementById(id); };
    var S = null;   // loaded file state

    var msg = $('msg'), fileInput = $('file'), drop = $('drop'), vwrap = $('viewer');
    var strip = $('strip'), overview = $('overview'), slider = $('slider');

    function setMsg(text, kind) {
      msg.textContent = text || '';
      msg.className = 'vmsg' + (kind ? ' ' + kind : '');
      msg.hidden = !text;
    }

    function readFile(file) {
      if (file.arrayBuffer) return file.arrayBuffer();
      return new Promise(function (res, rej) {
        var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { rej(fr.error); };
        fr.readAsArrayBuffer(file);
      });
    }

    function openFile(file) {
      setMsg('Reading ' + file.name + '…');
      readFile(file).then(function (buf) { return load(buf, file.name); })
        .catch(function (e) { fail(e); });
    }
    function fail(e) {
      setMsg(e && e.name === 'EdfError' ? e.message : 'The file could not be read. ' + (e && e.message ? e.message : ''), 'warn');
    }

    function load(buf, name) {
      var parsed = parseEdf(buf);
      var pick = pickEcg(parsed.signals);
      if (pick.index < 0) throw new EdfError('The file has no signal to draw.');
      return extractChannelAsync(parsed, pick.index, function (f) {
        if (parsed.records * parsed.recBytes > 8e6) setMsg('Reading ' + name + '… ' + Math.round(f * 100) + ' %');
      }).then(function (ecg) {
        parsed.buffer = null;
        show(parsed, pick, ecg, name, buf.byteLength);
      });
    }

    /* ---- state helpers ---- */
    function wallMs(t) { return S.parsed.header.startMs === null ? null : S.parsed.header.startMs + t * 1000; }
    function clampStart(t) { return Math.max(0, Math.min(S.r.maxStart(), t)); }
    function setStart(t) { S.start = clampStart(t); redraw(); }
    function redraw() {
      S.r.opts.marks = S.marks; S.r.opts.cal = S.cal;
      S.r.draw(S.start);
      slider.max = String(Math.max(0, S.r.maxStart()));
      slider.value = String(S.start);
      slider.disabled = S.r.maxStart() <= 0;
      var w = wallMs(S.start);
      $('winInfo').textContent = (w !== null ? fmtStamp(w, true) + '  ·  ' : '') + 'file time ' + fmtOffset(S.start, 1, S.total >= 3600)
        + '  ·  window ' + S.r.windowSec.toFixed(1) + ' s';
      drawOverview();
      calReadout();
    }

    function drawOverview() {
      var c = overview, dpr = root.devicePixelRatio || 1, cssW = Math.max(200, c.parentNode.clientWidth), cssH = 34;
      c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
      c.style.width = cssW + 'px'; c.style.height = cssH + 'px';
      var x = c.getContext('2d'), W = c.width, H = c.height;
      var paper = S.r.opts.paper;
      x.fillStyle = paper ? '#eeeeee' : '#262f3d'; x.fillRect(0, 0, W, H);
      var tot = Math.max(S.total, 1e-9), px = function (t) { return t / tot * W; };
      // hour ticks
      x.fillStyle = paper ? '#bbbbbb' : '#4a5568';
      for (var h = 3600; h < tot; h += 3600) x.fillRect(Math.round(px(h)), H * 0.55, Math.max(1, dpr), H * 0.45);
      // marks
      x.fillStyle = paper ? '#a35a07' : '#fbbf24';
      S.marks.forEach(function (m) { x.fillRect(Math.round(px(m.t)) - dpr, 0, Math.max(2, 2 * dpr), H * 0.7); });
      // current window
      x.strokeStyle = paper ? '#111111' : '#5fe3c8'; x.lineWidth = Math.max(1, 1.5 * dpr);
      var a = px(S.start), w = Math.max(3 * dpr, px(S.r.windowSec));
      x.strokeRect(a + x.lineWidth / 2, x.lineWidth / 2, Math.min(w, W - a) - x.lineWidth, H - x.lineWidth);
    }

    /* ---- calipers ---- */
    function calReadout() {
      var el = $('calOut');
      if (!S.calOn) { el.textContent = ''; return; }
      if (S.cal.length === 0) el.textContent = 'Calipers on. Click the strip to place the first line.';
      else if (S.cal.length === 1) el.textContent = 'Click to place the second line. Esc clears.';
      else {
        var ms = Math.abs(S.cal[1] - S.cal[0]) * 1000;
        el.textContent = Math.round(ms) + ' ms  ·  ' + (ms > 0 ? (60000 / ms).toFixed(1) : '–') + ' bpm if repeated. Click again to start over.';
      }
    }
    function placeCaliper(clientX) {
      var rect = strip.getBoundingClientRect();
      var xDev = (clientX - rect.left) * (strip.width / rect.width);
      var t = S.start + xDev / (S.r.ppm * S.r.opts.speed);
      if (S.cal.length >= 2) S.cal = [];
      S.cal.push(t);
      redraw();
    }
    function clearCal() { S.cal = []; redraw(); }

    /* ---- build the page for a loaded file ---- */
    function show(parsed, pick, ecg, name, size) {
      var h = parsed.header, sig = parsed.signals[pick.index];
      var rate = sig.rate;
      var total = ecg.length / rate;
      var marks = parsed.annotations.filter(function (a) { return /^mark/i.test(a.text); })
        .map(function (a) { return { t: a.onsetS, text: a.text }; });

      vwrap.hidden = false;
      var r = new Renderer(strip, ecg, rate, total);
      S = { parsed: parsed, pick: pick, name: name, size: size, ecg: ecg, rate: rate, total: total, r: r,
            start: 0, marks: marks, cal: [], calOn: false };

      // header card
      var kv = $('hdr'); kv.textContent = '';
      function row(k, v) {
        var dt = document.createElement('dt'), dd = document.createElement('dd');
        dt.textContent = k; dd.textContent = v; kv.appendChild(dt); kv.appendChild(dd);
      }
      row('File', name + '  (' + fmtBytes(size) + ')');
      row('Start', h.startMs !== null ? fmtStamp(h.startMs, true) : (h.startDate + ' ' + h.startTime));
      row('Length', fmtDuration(total) + (parsed.recordOnsets ? ' (with gaps)' : ''));
      var recTokens = h.recording.split(/\s+/);
      var appTok = recTokens.filter(function (t) { return /^Fairest_Heart/i.test(t); })[0];
      if (appTok) {
        row('App', appTok.replace(/^Fairest_Heart-?/i, 'Fairest Heart ').trim());
        var di = recTokens.indexOf(appTok), dev = recTokens.slice(di + 1).join(' ');
        if (dev) row('Device', dev);
      } else if (h.recording) row('Recording', h.recording);
      row('Patient field', h.patient || '(empty)');
      row('Format', h.kind === 'EDF' ? 'EDF' : h.kind === 'EDF+C' ? 'EDF+ (continuous)' : 'EDF+ (with gaps)');
      var ul = $('sigList'); ul.textContent = '';
      parsed.signals.forEach(function (s, i) {
        var li = document.createElement('li');
        var txt = s.isAnnotations ? 'Marks and notes (annotations)' :
          (s.label || 'Signal ' + (i + 1)) + '  ·  ' + (Math.round(s.rate * 100) / 100) + ' per second' + (s.dim ? '  ·  ' + s.dim : '');
        if (!s.isAnnotations) txt += i === pick.index ? '  ·  drawn below' : '  ·  listed, not drawn';
        li.textContent = txt; ul.appendChild(li);
      });
      var notes = [];
      if (!pick.found) notes.push('No signal is labelled ECG. The first signal (' + sig.label + ') is drawn instead.');
      if (parsed.truncated) notes.push('The file ends early. The whole records that are present are shown (' + fmtDuration(total) + ').');
      if (sig.dim && !/^(u|µ)?v$|^mv$/i.test(sig.dim.replace(/\s/g, ''))) notes.push('The unit is "' + sig.dim + '". The mV scale below assumes microvolts.');
      $('hdrNotes').textContent = notes.join(' ');
      $('hdrNotes').hidden = !notes.length;

      // marks list
      $('marksOnly').checked = marks.length > 0;
      buildMarks();

      // controls
      setPressed('speed', '25'); setPressed('gain', '10');
      $('paperBtn').setAttribute('aria-pressed', 'false');
      $('calBtn').setAttribute('aria-pressed', 'false');
      setMsg('');
      setStart(0);
      vwrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function buildMarks() {
      var list = $('marks'); list.textContent = '';
      var only = $('marksOnly').checked, anns = S.parsed.annotations;
      $('noMarks').hidden = anns.length > 0;
      $('marksTools').hidden = anns.length === 0;
      anns.forEach(function (a) {
        var isMark = /^mark/i.test(a.text);
        if (only && !isMark) return;
        var li = document.createElement('li'), b = document.createElement('button');
        b.type = 'button'; b.className = 'arow' + (isMark ? ' mark' : '');
        var w = wallMs(a.onsetS);
        var tm = document.createElement('span'); tm.className = 'at mono';
        tm.textContent = (w !== null ? fmtStamp(w, false) + '  ' : '') + '+' + fmtOffset(a.onsetS, 0, S.total >= 3600);
        var tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = a.text;
        b.appendChild(tm); b.appendChild(tx);
        b.addEventListener('click', function () {
          setStart(a.onsetS - S.r.windowSec / 3);
          $('stripCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        li.appendChild(b); list.appendChild(li);
      });
    }

    function setPressed(group, val) {
      document.querySelectorAll('[data-' + group + ']').forEach(function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-' + group) === val ? 'true' : 'false');
      });
    }

    /* ---- events ---- */
    $('openBtn').addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) openFile(fileInput.files[0]);
      fileInput.value = '';
    });
    $('sampleBtn').addEventListener('click', function () {
      setMsg('Loading the sample…');
      fetch('sample-fairest-heart.edf').then(function (res) {
        if (!res.ok) throw new Error('The sample was not found.');
        return res.arrayBuffer();
      }).then(function (buf) { return load(buf, 'sample-fairest-heart.edf'); })
        .catch(function (e) {
          setMsg(e && e.name === 'EdfError' ? e.message : 'The sample could not be loaded. It needs this page to be opened from a web address, not as a local file.', 'warn');
        });
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) openFile(f);
    });

    document.querySelectorAll('[data-speed]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!S) return;
        S.r.opts.speed = +b.getAttribute('data-speed'); S.r.updateWindow(); setPressed('speed', b.getAttribute('data-speed'));
        S.start = clampStart(S.start); redraw();
      });
    });
    document.querySelectorAll('[data-gain]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!S) return;
        S.r.opts.gain = +b.getAttribute('data-gain'); setPressed('gain', b.getAttribute('data-gain')); redraw();
      });
    });
    $('paperBtn').addEventListener('click', function () {
      if (!S) return;
      S.r.opts.paper = !S.r.opts.paper;
      this.setAttribute('aria-pressed', S.r.opts.paper ? 'true' : 'false'); redraw();
    });
    $('calBtn').addEventListener('click', function () {
      if (!S) return;
      S.calOn = !S.calOn; this.setAttribute('aria-pressed', S.calOn ? 'true' : 'false');
      if (!S.calOn) S.cal = [];
      strip.classList.toggle('cal', S.calOn); redraw();
    });
    $('prevBtn').addEventListener('click', function () { if (S) setStart(S.start - S.r.windowSec); });
    $('nextBtn').addEventListener('click', function () { if (S) setStart(S.start + S.r.windowSec); });
    $('printBtn').addEventListener('click', function () { if (S) root.print(); });
    slider.addEventListener('input', function () { if (S) setStart(+slider.value); });
    $('marksOnly').addEventListener('change', function () { if (S) buildMarks(); });

    // drag to pan; a click without movement places a caliper line
    var drag = null;
    strip.addEventListener('pointerdown', function (e) {
      if (!S) return;
      strip.focus({ preventScroll: true });
      drag = { x0: e.clientX, s0: S.start, moved: false, id: e.pointerId };
      try { strip.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    });
    strip.addEventListener('pointermove', function (e) {
      if (!drag || !S) return;
      var dx = e.clientX - drag.x0;
      if (Math.abs(dx) > 4) drag.moved = true;
      if (drag.moved) {
        var rect = strip.getBoundingClientRect();
        var devDx = dx * (strip.width / rect.width);
        setStart(drag.s0 - devDx / (S.r.ppm * S.r.opts.speed));
      }
    });
    function endDrag(e, cancelled) {
      if (!drag) return;
      var d = drag; drag = null;
      if (!cancelled && !d.moved && S && S.calOn) placeCaliper(e.clientX);
    }
    strip.addEventListener('pointerup', function (e) { endDrag(e, false); });
    strip.addEventListener('pointercancel', function (e) { endDrag(e, true); });
    strip.addEventListener('wheel', function (e) {
      if (!S || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault(); setStart(S.start + e.deltaX / (S.r.ppm / (root.devicePixelRatio || 1) * S.r.opts.speed));
    }, { passive: false });
    strip.addEventListener('keydown', function (e) {
      if (!S) return;
      var big = S.r.windowSec, small = S.r.windowSec * 0.1, handled = true;
      if (e.key === 'ArrowLeft') setStart(S.start - (e.shiftKey ? big : small));
      else if (e.key === 'ArrowRight') setStart(S.start + (e.shiftKey ? big : small));
      else if (e.key === 'PageUp') setStart(S.start - big);
      else if (e.key === 'PageDown') setStart(S.start + big);
      else if (e.key === 'Home') setStart(0);
      else if (e.key === 'End') setStart(S.total);
      else handled = false;
      if (handled) e.preventDefault();
    });
    document.addEventListener('keydown', function (e) { if (S && e.key === 'Escape' && S.cal.length) clearCal(); });

    // click or drag on the whole-recording bar
    var ovDrag = false;
    function ovJump(e) {
      var rect = overview.getBoundingClientRect();
      var f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setStart(f * S.total - S.r.windowSec / 2);
    }
    overview.addEventListener('pointerdown', function (e) {
      if (!S) return; ovDrag = true;
      try { overview.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      ovJump(e);
    });
    overview.addEventListener('pointermove', function (e) { if (ovDrag && S) ovJump(e); });
    overview.addEventListener('pointerup', function () { ovDrag = false; });
    overview.addEventListener('pointercancel', function () { ovDrag = false; });

    var rt = null;
    root.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { if (S) { S.r.resize(); S.start = clampStart(S.start); redraw(); } }, 120);
    });

    /* ---- print: a separate canvas at 12 device px per mm, paper look, true size ---- */
    function preparePrint() {
      if (!S) return;
      var o = S.r.opts, pc = $('printCanvas'), ppm = 12;
      var sec = Math.min(S.r.windowSec, 250 / o.speed), widthMm = sec * o.speed;
      pc.width = Math.round(widthMm * ppm); pc.height = STRIP_MM * ppm;
      pc.style.width = widthMm + 'mm'; pc.style.height = STRIP_MM + 'mm';
      drawStrip(pc.getContext('2d'), {
        W: pc.width, H: pc.height, ppm: ppm, startS: S.start, speed: o.speed, gain: o.gain, paper: true,
        ecg: S.ecg, rate: S.rate, marks: S.marks, cal: S.cal, dpr: 3, fs: 34, traceW: 3,
        lineMinor: 1, lineMajor: 2, totalS: S.total
      });
      var w = wallMs(S.start), w2 = wallMs(S.start + sec), h = S.parsed.header;
      $('pFile').textContent = 'File start: ' + (h.startMs !== null ? fmtStamp(h.startMs, true) : h.startDate + ' ' + h.startTime);
      $('pWin').textContent = 'This strip: ' + (w !== null ? fmtStamp(w, true) + ' to ' + fmtStamp(w2, false) + '  ·  ' : '')
        + 'file time ' + fmtOffset(S.start, 1, S.total >= 3600) + ' to ' + fmtOffset(S.start + sec, 1, S.total >= 3600);
      $('pScale').textContent = o.speed + ' mm/s · ' + o.gain + ' mm/mV';
    }
    root.addEventListener('beforeprint', preparePrint);
  }

  /* ================================================================ exports */

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseEdf: parseEdf, extractChannel: extractChannel, parseTals: parseTals,
                       pickEcg: pickEcg, extractChannelAsync: extractChannelAsync };
  }
  if (typeof document !== 'undefined' && document.getElementById && document.getElementById('strip')) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUi); else initUi();
  }
})(typeof window !== 'undefined' ? window : this);
