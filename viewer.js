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

  function fillChannel(parsed, index, out, r0, r1, raw) {
    var sg = parsed.signals[index];
    var dv = new DataView(parsed.buffer);
    var spr = sg.samplesPerRecord;
    var span = sg.dmax - sg.dmin;
    var scale = span !== 0 ? (sg.pmax - sg.pmin) / span : 1;
    var unit = raw ? 1 : unitFactorToMv(sg.dim);
    var k = scale * unit, c0 = sg.dmin, p0 = sg.pmin * unit;
    for (var r = r0; r < r1; r++) {
      var pos = parsed.dataStart + r * parsed.recBytes + sg.offsetInRecord * 2;
      var o = parsed.recordOnsets ? Math.round(parsed.recordOnsets[r] * sg.rate) : r * spr;
      for (var j = 0; j < spr; j++, pos += 2) out[o + j] = (dv.getInt16(pos, true) - c0) * k + p0;
    }
  }

  /* One channel as Float32Array, in millivolts when the unit is uV / mV / V;
     with raw set, in the file's own physical unit. */
  function extractChannel(parsed, index, raw) {
    var out = new Float32Array(channelLength(parsed, index));
    if (parsed.recordOnsets) out.fill(NaN);
    fillChannel(parsed, index, out, 0, parsed.records, raw);
    return out;
  }
  /* The RR channel the app writes (ms, sample-and-hold at the ECG rate), or -1. */
  function pickRr(signals, ecgIndex) {
    for (var i = 0; i < signals.length; i++) {
      var s = signals[i];
      if (!s.isAnnotations && i !== ecgIndex && /^RR$/i.test(s.label) && /^ms$/i.test(s.dim) && s.rate === signals[ecgIndex].rate) return i;
    }
    return -1;
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

  /* ================================================================ header fields */

  /* EDF+ patient field: "code sex birthdate name", X for unknown, _ for spaces.
     Returns {plus:true, code, sex ('M'|'F'|''), birthMs|null, name} or {plus:false, raw}. */
  function parsePatient(s) {
    var t = (s || '').trim().split(/\s+/);
    var birthRe = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/;
    if (t.length < 4 || !/^[MFX]$/i.test(t[1]) || !(t[2] === 'X' || birthRe.test(t[2]))) return { plus: false, raw: s || '' };
    var un = function (x) { return x === 'X' ? '' : x.replace(/_/g, ' '); };
    var bm = birthRe.exec(t[2]), birthMs = null;
    if (bm && MONTHS[bm[2].toUpperCase()] !== undefined) birthMs = Date.UTC(+bm[3], MONTHS[bm[2].toUpperCase()], +bm[1]);
    var sex = t[1].toUpperCase();
    return { plus: true, code: un(t[0]), sex: sex === 'X' ? '' : sex, birthMs: birthMs, name: un(t.slice(3).join(' ')) };
  }
  function ageAt(birthMs, atMs) {
    var b = new Date(birthMs), a = new Date(atMs);
    var y = a.getUTCFullYear() - b.getUTCFullYear();
    if (a.getUTCMonth() < b.getUTCMonth() || (a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() < b.getUTCDate())) y--;
    return y;
  }

  /* ================================================================ drawing */

  var DARK = { bg: '#0d1118', minor: 'rgba(154,163,178,0.10)', major: 'rgba(154,163,178,0.26)',
               trace: '#5fe3c8', mark: '#fbbf24', cal: '#b9a6ff', text: '#9aa3b2' };
  var PAPER = { bg: '#ffffff', minor: '#f7d3d6', major: '#eba2a9',
                trace: '#111111', mark: '#a35a07', cal: '#1d4ed8', text: '#444444' };
  var ROW_MM = 40;        // one row: +-2 mV at 10 mm/mV; a multiple of 5 so the big squares line up across rows
  var CAL_S = 0.2;        // calibration pulse: 1 mV for 0.2 s (5 mm at 25 mm/s)
  var MONO = 'ui-monospace, Menlo, Consolas, "Roboto Mono", monospace';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtOffset(t, dec, forceHours) {
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
  function fmtDate(ms) {
    var d = new Date(ms);
    return pad2(d.getUTCDate()) + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
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

  /* Paper layout for a canvas of widthPx device pixels at ppm device px per mm.
     A gutter at the left holds the calibration pulse; the trace area is a whole
     number of big squares so the grid lines up from row to row. */
  function stripLayout(widthPx, ppm, speed) {
    var totalMm = Math.floor(widthPx / ppm);
    var gutterMm = 2 + CAL_S * speed + 2;
    var traceMm = Math.max(25, Math.floor((totalMm - gutterMm) / 5) * 5);
    return { gutterMm: gutterMm, traceMm: traceMm, widthMm: gutterMm + traceMm, rowSec: traceMm / speed };
  }

  /* Heart rate over one row from the RR channel (ms, sample-and-hold at the ECG
     rate, 0 before the second beat). Time-weighted mean; null when the row has
     no beats for half its length or more. */
  function rowHr(rr, rate, startS, rowSec) {
    if (!rr) return null;
    var i0 = Math.max(0, Math.round(startS * rate)), i1 = Math.min(rr.length, Math.round((startS + rowSec) * rate));
    if (i1 <= i0) return null;
    var sum = 0, n = 0;
    for (var i = i0; i < i1; i++) { var v = rr[i]; if (v > 0) { sum += v; n++; } }
    if (n === 0 || n < (i1 - i0) / 2) return null;
    return Math.round(60000 / (sum / n));
  }

  /* Display filter: second-order Butterworth high-pass at fc Hz, run forward then
     backward so it adds no delay, restarted after every gap. This is the usual
     "monitor mode" baseline removal; the file itself is left as recorded. */
  function highPass(x, rate, fc) {
    var n = x.length, y = new Float32Array(n);
    var w = Math.tan(Math.PI * fc / rate), w2 = w * w, s2 = Math.SQRT2 * w, a0 = 1 + s2 + w2;
    var b0 = 1 / a0, b1 = -2 / a0, b2 = 1 / a0, a1 = 2 * (w2 - 1) / a0, a2 = (1 - s2 + w2) / a0;
    function pass(src, dst, dir) {
      var x1 = 0, x2 = 0, y1 = 0, y2 = 0, fresh = true, i, end = dir > 0 ? n : -1;
      for (i = dir > 0 ? 0 : n - 1; i !== end; i += dir) {
        var v = src[i];
        if (v !== v) { dst[i] = NaN; fresh = true; continue; }
        if (fresh) { x1 = x2 = v; y1 = y2 = 0; fresh = false; }   // settle on the first sample: no step
        var o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = v; y2 = y1; y1 = o; dst[i] = o;
      }
    }
    pass(x, y, 1); pass(y, y, -1);
    return y;
  }

  /* Heart rate per bin of binSec over the whole RR channel: Float32Array, NaN where
     a bin has no beats for half its length. */
  function hrTrend(rr, rate, totalS, binSec) {
    var n = Math.ceil(totalS / binSec), out = new Float32Array(n);
    for (var b = 0; b < n; b++) { var h = rowHr(rr, rate, b * binSec, binSec); out[b] = h === null ? NaN : h; }
    return out;
  }

  /* Draw a stacked strip: g.rows rows of g.traceMm mm each, continuous in time.
     g: {W,H,ppm (device px per mm), startS, speed (mm/s), gain (mm/mV), paper, rows,
     gutterMm, traceMm, ecg, rate, rr, startMs, lead (text), filtered (bool),
     marks:[{t,text}], cal:[t,t], dpr, fs (font px), traceW, lineMinor, lineMajor, totalS} */
  function drawStrip(ctx, g) {
    var W = g.W, H = g.H, ppm = g.ppm, pal = g.paper ? PAPER : DARK, sp = g.speed, rows = g.rows, i, r;
    var gpx = g.gutterMm * ppm, rowH = ROW_MM * ppm, rowSec = g.traceMm / sp;
    var x0mm = g.startS * sp - g.gutterMm;   // paper mm at canvas x = 0, anchored to time zero
    var forceH = g.totalS >= 3600, fs = g.fs, dpr = g.dpr || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H);

    // grid: 1 mm minor, 5 mm major. Rows are a whole number of big squares, so one pass covers them all.
    function isMajor(m) { return ((m % 5) + 5) % 5 === 0; }
    function gridPass(major, lw, color) {
      var o = (lw % 2) / 2, m, x, y;
      ctx.beginPath(); ctx.lineWidth = lw; ctx.strokeStyle = color;
      for (m = Math.floor(x0mm); m <= Math.ceil(x0mm + W / ppm); m++) {
        if (isMajor(m) !== major) continue;
        x = Math.round((m - x0mm) * ppm) + o; ctx.moveTo(x, 0); ctx.lineTo(x, H);
      }
      for (m = 0; m <= Math.floor(H / ppm); m++) {
        if (isMajor(m) !== major) continue;
        y = Math.round(m * ppm) + o; ctx.moveTo(0, y); ctx.lineTo(W, y);
      }
      ctx.stroke();
    }
    gridPass(false, g.lineMinor, pal.minor);
    gridPass(true, g.lineMajor, pal.major);

    var d = g.ecg, rate = g.rate, gainPx = g.gain * ppm, k = sp * ppm / rate;
    var marks = g.marks || [], cal = g.cal || [];
    function rowOf(t) { return Math.floor((t - g.startS) / rowSec); }
    function xOf(t, rs) { return gpx + (t - rs) * sp * ppm; }

    for (r = 0; r < rows; r++) {
      var rs = g.startS + r * rowSec, yTop = r * rowH, yc = yTop + rowH / 2;

      // calibration pulse: 1 mV for CAL_S seconds, then the baseline runs into the trace
      ctx.beginPath(); ctx.lineWidth = g.traceW; ctx.lineJoin = 'miter'; ctx.lineCap = 'butt'; ctx.strokeStyle = pal.trace;
      var c1 = 2 * ppm, c2 = (2 + CAL_S * sp) * ppm;
      ctx.moveTo(0.5 * ppm, yc); ctx.lineTo(c1, yc); ctx.lineTo(c1, yc - gainPx);
      ctx.lineTo(c2, yc - gainPx); ctx.lineTo(c2, yc); ctx.lineTo(gpx, yc);
      ctx.stroke();

      // trace, clipped to this row's paper
      ctx.save(); ctx.beginPath(); ctx.rect(gpx, yTop, W - gpx, rowH); ctx.clip();
      var iA = Math.max(0, Math.floor(rs * rate) - 1);
      var iB = Math.min(d.length - 1, Math.ceil((rs + rowSec) * rate) + 1);
      ctx.beginPath(); ctx.lineWidth = g.traceW; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      var pen = false, xo = gpx - rs * sp * ppm;
      for (i = iA; i <= iB; i++) {
        var v = d[i];
        if (v !== v) { pen = false; continue; }
        var y = yc - v * gainPx; if (y < yTop + 1) y = yTop + 1; else if (y > yTop + rowH - 1) y = yTop + rowH - 1;
        var x = xo + i * k;
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
      ctx.stroke();

      // row label: clock time where the row starts, heart rate when the file carries RR
      ctx.font = fs + 'px ' + MONO; ctx.fillStyle = pal.text; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      var hr = rowHr(g.rr, rate, rs, rowSec);
      var lab = (g.startMs !== null && g.startMs !== undefined ? fmtStamp(g.startMs + rs * 1000, false) : fmtOffset(rs, 0, forceH))
        + (hr !== null ? '  ·  ' + hr + ' bpm' : '');
      ctx.fillText(lab, gpx + fs * 0.5, yTop + fs * 1.2);
      if (r === 0) {
        ctx.textAlign = 'right';
        ctx.fillText((g.lead ? g.lead + ' · ' : '') + sp + ' mm/s · ' + g.gain + ' mm/mV' + (g.filtered ? ' · 0.5 Hz' : ''), W - fs * 0.5, yTop + fs * 1.2);
        ctx.textAlign = 'left';
      }

      // marks the wearer made
      for (i = 0; i < marks.length; i++) {
        var mk = marks[i];
        if (rowOf(mk.t) !== r) continue;
        var mx = Math.round(xOf(mk.t, rs)) + 0.5;
        ctx.save();
        ctx.strokeStyle = pal.mark; ctx.lineWidth = Math.max(1, Math.round(dpr)); ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.beginPath(); ctx.moveTo(mx, yTop); ctx.lineTo(mx, yTop + rowH); ctx.stroke(); ctx.restore();
        var txt = mk.text.length > 48 ? mk.text.slice(0, 47) + '…' : mk.text;
        ctx.fillStyle = pal.mark; ctx.font = fs + 'px ' + MONO;
        var tw = ctx.measureText(txt).width;
        if (mx + fs * 0.4 + tw > W) { ctx.textAlign = 'right'; ctx.fillText(txt, mx - fs * 0.4, yTop + fs * 2.6); }
        else { ctx.textAlign = 'left'; ctx.fillText(txt, mx + fs * 0.4, yTop + fs * 2.6); }
        ctx.textAlign = 'left';
      }
      ctx.restore();
    }

    // calipers: a line in whichever row each falls; the span is written next to the second
    if (cal.length) {
      ctx.strokeStyle = pal.cal; ctx.fillStyle = pal.cal; ctx.lineWidth = Math.max(1, Math.round(dpr * 1.2));
      ctx.font = fs + 'px ' + MONO; ctx.textAlign = 'center';
      var cr = cal.map(rowOf), cx = cal.map(function (t, j) { return Math.round(xOf(t, g.startS + cr[j] * rowSec)) + 0.5; });
      cal.forEach(function (t, j) {
        if (cr[j] < 0 || cr[j] >= rows) return;
        ctx.beginPath(); ctx.moveTo(cx[j], cr[j] * rowH); ctx.lineTo(cx[j], (cr[j] + 1) * rowH); ctx.stroke();
      });
      if (cal.length === 2 && cr[1] >= 0 && cr[1] < rows) {
        var ya = Math.round(cr[1] * rowH + rowH * 0.82) + 0.5, label = Math.round(Math.abs(cal[1] - cal[0]) * 1000) + ' ms';
        if (cr[0] === cr[1]) {
          ctx.beginPath(); ctx.moveTo(cx[0], ya); ctx.lineTo(cx[1], ya); ctx.stroke();
          ctx.fillText(label, (cx[0] + cx[1]) / 2, ya - fs * 0.4);
        } else ctx.fillText(label, cx[1], ya - fs * 0.4);
      }
      ctx.textAlign = 'left';
    }
  }

  function Renderer(canvas, ecg, rate, totalS, rr, startMs, lead) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.ecgRaw = ecg; this.ecgFiltered = null; this.rate = rate; this.totalS = totalS; this.rr = rr || null;
    this.startMs = startMs; this.lead = lead || '';
    this.opts = { speed: 25, gain: 10, paper: true, filter: true, marks: [], cal: [] };
    this.rows = 3; this.rowSec = 10; this.windowSec = 30; this.lastStart = 0;
    this.resize();
  }
  Renderer.prototype.resize = function () {
    var c = this.canvas, dpr = root.devicePixelRatio || 1;
    this.cssW = Math.max(240, c.parentNode.clientWidth || c.clientWidth || 600);
    var base = this.cssW < 520 ? 3 : 4;                   // css px per mm on screen
    this.dpr = dpr;
    this.ppm = Math.max(2, Math.round(base * dpr));       // whole device px per mm: crisp grid
    this.updateWindow();
  };
  /* The gutter depends on the speed, so a speed change re-lays the canvas out. */
  Renderer.prototype.updateWindow = function () {
    var c = this.canvas, lay = stripLayout(Math.round(this.cssW * this.dpr), this.ppm, this.opts.speed);
    this.lay = lay;
    c.width = lay.widthMm * this.ppm;
    c.height = this.rows * ROW_MM * this.ppm;
    c.style.width = (c.width / this.dpr) + 'px';
    c.style.height = (c.height / this.dpr) + 'px';
    this.rowSec = lay.rowSec;
    this.windowSec = lay.rowSec * this.rows;
  };
  Renderer.prototype.maxStart = function () { return Math.max(0, this.totalS - this.windowSec); };
  /* The trace to draw: filtered when the toggle is on (computed once, on first use). */
  Renderer.prototype.trace = function () {
    if (!this.opts.filter) return this.ecgRaw;
    if (!this.ecgFiltered) this.ecgFiltered = highPass(this.ecgRaw, this.rate, 0.5);
    return this.ecgFiltered;
  };
  /* File time under a canvas point (device px). */
  Renderer.prototype.timeAt = function (startS, xDev, yDev) {
    var row = Math.max(0, Math.min(this.rows - 1, Math.floor(yDev / (ROW_MM * this.ppm))));
    return startS + row * this.rowSec + (xDev - this.lay.gutterMm * this.ppm) / (this.ppm * this.opts.speed);
  };
  Renderer.prototype.draw = function (windowStartS) {
    this.lastStart = windowStartS;
    var o = this.opts, dpr = this.dpr;
    drawStrip(this.ctx, {
      W: this.canvas.width, H: this.canvas.height, ppm: this.ppm, startS: windowStartS,
      speed: o.speed, gain: o.gain, paper: o.paper, rows: this.rows, gutterMm: this.lay.gutterMm, traceMm: this.lay.traceMm,
      ecg: this.trace(), rate: this.rate, rr: this.rr, startMs: this.startMs, lead: this.lead, filtered: o.filter,
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
        var ri = pickRr(parsed.signals, pick.index), rr = ri >= 0 ? extractChannel(parsed, ri, true) : null;
        parsed.buffer = null;
        show(parsed, pick, ecg, rr, name, buf.byteLength);
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

    /* The whole recording as a bar: hour ticks, marks, the window; with an RR
       channel also the heart rate per minute, as the trend on a Holter report. */
    function drawOverview() {
      var c = overview, dpr = root.devicePixelRatio || 1, cssW = Math.max(200, c.parentNode.clientWidth);
      var trend = S.trend, cssH = trend ? 72 : 34;
      c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
      c.style.width = cssW + 'px'; c.style.height = cssH + 'px';
      var x = c.getContext('2d'), W = c.width, H = c.height, i;
      var paper = S.r.opts.paper;
      x.fillStyle = paper ? '#eeeeee' : '#262f3d'; x.fillRect(0, 0, W, H);
      var tot = Math.max(S.total, 1e-9), px = function (t) { return t / tot * W; };
      // hour ticks
      x.fillStyle = paper ? '#bbbbbb' : '#4a5568';
      for (var h = 3600; h < tot; h += 3600) x.fillRect(Math.round(px(h)), H * 0.55, Math.max(1, dpr), H * 0.45);
      if (trend) {
        var lo = Infinity, hi = -Infinity;
        for (i = 0; i < trend.length; i++) { var v = trend[i]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } }
        if (hi > lo - 1) {
          lo = Math.floor((lo - 5) / 10) * 10; hi = Math.ceil((hi + 5) / 10) * 10;
          var fs = Math.round(10 * dpr), top = fs * 1.3, bot = H - fs * 0.3;
          var py = function (b) { return bot - (b - lo) / (hi - lo) * (bot - top); };
          x.strokeStyle = paper ? '#111111' : '#5fe3c8'; x.lineWidth = Math.max(1, 1.25 * dpr); x.lineJoin = 'round';
          x.beginPath(); var pen = false;
          for (i = 0; i < trend.length; i++) {
            if (trend[i] !== trend[i]) { pen = false; continue; }
            var tx = px((i + 0.5) * 60), ty = py(trend[i]);
            if (pen) x.lineTo(tx, ty); else { x.moveTo(tx, ty); pen = true; }
          }
          x.stroke();
          x.font = fs + 'px ' + MONO; x.fillStyle = paper ? '#555555' : '#9aa3b2'; x.textAlign = 'right';
          x.fillText(hi + ' bpm', W - fs * 0.4, fs); x.fillText(lo + ' bpm', W - fs * 0.4, H - fs * 0.4); x.textAlign = 'left';
        }
      }
      // marks
      x.fillStyle = paper ? '#a35a07' : '#fbbf24';
      S.marks.forEach(function (m) { x.fillRect(Math.round(px(m.t)) - dpr, 0, Math.max(2, 2 * dpr), trend ? H * 0.35 : H * 0.7); });
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
    function placeCaliper(clientX, clientY) {
      var rect = strip.getBoundingClientRect();
      var xDev = (clientX - rect.left) * (strip.width / rect.width);
      var yDev = (clientY - rect.top) * (strip.height / rect.height);
      var t = S.r.timeAt(S.start, xDev, yDev);
      if (S.cal.length >= 2) S.cal = [];
      S.cal.push(t);
      redraw();
    }
    function clearCal() { S.cal = []; redraw(); }

    /* ---- build the page for a loaded file ---- */
    function show(parsed, pick, ecg, rr, name, size) {
      var h = parsed.header, sig = parsed.signals[pick.index];
      var rate = sig.rate;
      var total = ecg.length / rate;
      var marks = parsed.annotations.filter(function (a) { return /^mark/i.test(a.text); })
        .map(function (a) { return { t: a.onsetS, text: a.text }; });

      vwrap.hidden = false;
      var r = new Renderer(strip, ecg, rate, total, rr, h.startMs, 'chest strap, single lead');
      S = { parsed: parsed, pick: pick, name: name, size: size, ecg: ecg, rr: rr, rate: rate, total: total, r: r,
            start: 0, marks: marks, cal: [], calOn: false, trend: rr ? hrTrend(rr, rate, total, 60) : null };

      // header card
      var kv = $('hdr'); kv.textContent = '';
      function row(k, v) {
        var dt = document.createElement('dt'), dd = document.createElement('dd');
        dt.textContent = k; dd.textContent = v; kv.appendChild(dt); kv.appendChild(dd);
      }
      var startTxt = h.startMs !== null ? fmtStamp(h.startMs, true) : (h.startDate + ' ' + h.startTime);
      var lenTxt = fmtDuration(total) + (parsed.recordOnsets ? ' (with gaps)' : '');
      var recTokens = h.recording.split(/\s+/), appTxt = '', devTxt = '';
      var appTok = recTokens.filter(function (t) { return /^Fairest_Heart/i.test(t); })[0];
      if (appTok) {
        appTxt = appTok.replace(/^Fairest_Heart-?/i, 'Fairest Heart ').trim();
        var di = recTokens.indexOf(appTok);
        devTxt = recTokens.slice(di + 1).join(' ').replace(/^Polar-H10$/i, 'Polar H10 chest strap, single lead');
      }
      // banner above the strip: who, then the recording
      var pt = parsePatient(h.patient), who = [], rec = [];
      if (pt.plus) {
        who.push(pt.name || 'No name in the file');
        if (pt.birthMs !== null) who.push('born ' + fmtDate(pt.birthMs) + (h.startMs !== null ? ' (' + ageAt(pt.birthMs, h.startMs) + ')' : ''));
        if (pt.sex) who.push(pt.sex === 'M' ? 'Male' : 'Female');
        if (pt.code) who.push('ID ' + pt.code);
      } else who.push(h.patient && h.patient !== 'X' ? h.patient : 'No name in the file');
      rec.push(startTxt); rec.push(lenTxt);
      if (devTxt) rec.push(devTxt); else if (!appTok && h.recording) rec.push(h.recording);
      if (appTxt) rec.push(appTxt);
      if (rr) rec.push('heart rate per row from the file\u2019s RR channel');
      $('bnWho').textContent = who.join('  \u00b7  ');
      $('bnRec').textContent = rec.join('  \u00b7  ');
      S.banner = { who: who.join('  \u00b7  '), rec: rec.join('  \u00b7  ') };
      // file details
      row('File', name + '  (' + fmtBytes(size) + ')');
      row('Start', startTxt);
      row('Length', lenTxt);
      if (appTxt) row('App', appTxt);
      if (devTxt) row('Device', devTxt); else if (h.recording) row('Recording', h.recording);
      if (pt.plus) {
        row('Name', pt.name || '(not in the file)');
        row('Born', pt.birthMs !== null ? fmtDate(pt.birthMs) : '(not in the file)');
        row('Sex', pt.sex === 'M' ? 'Male' : pt.sex === 'F' ? 'Female' : '(not in the file)');
        row('ID', pt.code || '(not in the file)');
      } else row('Patient field', h.patient || '(empty)');
      row('Format', h.kind === 'EDF' ? 'EDF' : h.kind === 'EDF+C' ? 'EDF+ (continuous)' : 'EDF+ (with gaps)');
      var ul = $('sigList'); ul.textContent = '';
      parsed.signals.forEach(function (s, i) {
        var li = document.createElement('li');
        var txt = s.isAnnotations ? 'Marks and notes (annotations)' :
          (s.label || 'Signal ' + (i + 1)) + '  ·  ' + (Math.round(s.rate * 100) / 100) + ' per second' + (s.dim ? '  ·  ' + s.dim : '');
        if (!s.isAnnotations) txt += i === pick.index ? '  ·  drawn' : (rr && /^RR$/i.test(s.label)) ? '  ·  heart rate per row' : '  ·  listed, not drawn';
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
      r.opts.paper = true; r.opts.filter = true;
      $('paperBtn').setAttribute('aria-pressed', 'true');
      $('filterBtn').setAttribute('aria-pressed', 'true');
      $('calBtn').setAttribute('aria-pressed', 'false');
      strip.classList.remove('cal');
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
          setStart(a.onsetS - S.r.rowSec / 3);
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
    $('filterBtn').addEventListener('click', function () {
      if (!S) return;
      S.r.opts.filter = !S.r.opts.filter;
      this.setAttribute('aria-pressed', S.r.opts.filter ? 'true' : 'false'); redraw();
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
      if (!cancelled && !d.moved && S && S.calOn) placeCaliper(e.clientX, e.clientY);
    }
    strip.addEventListener('pointerup', function (e) { endDrag(e, false); });
    strip.addEventListener('pointercancel', function (e) { endDrag(e, true); });
    strip.addEventListener('wheel', function (e) {
      if (!S || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault(); setStart(S.start + e.deltaX / (S.r.ppm / (root.devicePixelRatio || 1) * S.r.opts.speed));
    }, { passive: false });
    strip.addEventListener('keydown', function (e) {
      if (!S) return;
      var big = S.r.windowSec, small = S.r.rowSec * 0.1, handled = true;
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

    /* ---- print: a separate canvas at 12 device px per mm, paper look, true size:
       three rows, 250 mm of trace each (10 s at 25 mm/s), landscape ---- */
    function preparePrint() {
      if (!S) return;
      var o = S.r.opts, pc = $('printCanvas'), ppm = 12, rows = 3;
      var lay = stripLayout(259 * ppm, ppm, o.speed), sec = lay.rowSec * rows;
      pc.width = lay.widthMm * ppm; pc.height = rows * ROW_MM * ppm;
      pc.style.width = lay.widthMm + 'mm'; pc.style.height = (rows * ROW_MM) + 'mm';
      drawStrip(pc.getContext('2d'), {
        W: pc.width, H: pc.height, ppm: ppm, startS: S.start, speed: o.speed, gain: o.gain, paper: true,
        rows: rows, gutterMm: lay.gutterMm, traceMm: lay.traceMm,
        ecg: S.r.trace(), rate: S.rate, rr: S.rr, startMs: S.parsed.header.startMs, lead: S.r.lead, filtered: o.filter,
        marks: S.marks, cal: S.cal, dpr: 3, fs: 34, traceW: 3,
        lineMinor: 1, lineMajor: 2, totalS: S.total
      });
      var w = wallMs(S.start), w2 = wallMs(S.start + sec);
      $('pFile').textContent = S.banner.who + '  ·  ' + S.banner.rec;
      $('pWin').textContent = 'This strip: ' + (w !== null ? fmtStamp(w, true) + ' to ' + fmtStamp(w2, false) + '  ·  ' : '')
        + 'file time ' + fmtOffset(S.start, 1, S.total >= 3600) + ' to ' + fmtOffset(S.start + sec, 1, S.total >= 3600)
        + '  ·  rows of ' + lay.rowSec.toFixed(1) + ' s, each continuing the one above';
      $('pScale').textContent = 'Chest strap, single lead · ' + o.speed + ' mm/s · ' + o.gain + ' mm/mV · the square pulse at the left of each row is 1 mV'
        + (o.filter ? ' · baseline filter 0.5 Hz (display only; the file is as recorded)' : ' · as recorded, no filter');
    }
    root.addEventListener('beforeprint', preparePrint);
  }

  /* ================================================================ exports */

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseEdf: parseEdf, extractChannel: extractChannel, parseTals: parseTals,
                       pickEcg: pickEcg, pickRr: pickRr, extractChannelAsync: extractChannelAsync,
                       parsePatient: parsePatient, ageAt: ageAt, stripLayout: stripLayout, rowHr: rowHr,
                       drawStrip: drawStrip, ROW_MM: ROW_MM, highPass: highPass, hrTrend: hrTrend };
  }
  if (typeof document !== 'undefined' && document.getElementById && document.getElementById('strip')) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUi); else initUi();
  }
})(typeof window !== 'undefined' ? window : this);
