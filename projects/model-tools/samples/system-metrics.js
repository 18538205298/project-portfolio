const fs = require('node:fs');

function readMem() {
  try {
    const t = fs.readFileSync('/proc/meminfo', 'utf8');
    const g = (k) => { const m = t.match(new RegExp('^' + k + ':\\s+(\\d+)\\s*kB', 'm')); return m ? Number(m[1]) * 1024 : 0; };
    return { total: g('MemTotal'), avail: g('MemAvailable'), free: g('MemFree'), buff: g('Buffers'), cached: g('Cached') };
  } catch (e) { return null; }
}

function readNet() {
  try {
    const t = fs.readFileSync('/proc/net/dev', 'utf8');
    for (const line of t.split('\n')) {
      const m = line.match(/^\s+(\S+):\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
      if (m && m[1] !== 'lo') return { rx: Number(m[2]), tx: Number(m[3]) };
    }
  } catch (e) { /* skip */ }
  return null;
}

function readDisk() {
  try {
    const st = fs.statfsSync('/');
    const total = st.blocks * st.bsize;
    const avail = st.bavail * st.bsize;
    const used = total - avail;
    return { total, avail, used, pct: total > 0 ? used / total * 100 : 0 };
  } catch (e) { return null; }
}

