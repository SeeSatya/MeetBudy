/* Finalize MediaRecorder WebM/Matroska containers without changing encoded media.
 * Read headers and small block prefixes through Blob slices; keep cluster bytes
 * as Blob slices instead of copying a potentially multi-hour recording into RAM.
 */
(function () {
  'use strict';
  if (window.MeetBudyMetadata) return;
  const ID = { EBML: 0x1a45dfa3, SEGMENT: 0x18538067, INFO: 0x1549a966,
    TRACKS: 0x1654ae6b, CLUSTER: 0x1f43b675, CUES: 0x1c53bb6b, SEEK: 0x114d9b74 };
  const levelOne = new Set([ID.INFO, ID.TRACKS, ID.CLUSTER, ID.CUES, ID.SEEK, 0x1254c367, 0x1941a469, 0x1043a770]);
  const fail = message => { throw new Error('Recording metadata: ' + message); };
  function vint(bytes, offset, identifier = false) {
    const first = bytes[offset];
    if (!first) fail('invalid EBML integer');
    let width = 1, mask = 128;
    while (!(first & mask)) { width++; mask /= 2; }
    if (width > (identifier ? 4 : 8) || offset + width > bytes.length) fail('truncated EBML integer');
    let value = identifier ? first : first & (mask - 1), unknown = !identifier && value === mask - 1;
    for (let i = 1; i < width; i++) { value = value * 256 + bytes[offset + i]; unknown = unknown && bytes[offset + i] === 255; }
    if (!unknown && !Number.isSafeInteger(value)) fail('EBML integer exceeds safe file size');
    return { value, width, unknown };
  }
  function uint(bytes) { let value = 0; for (const byte of bytes) value = value * 256 + byte; if (!Number.isSafeInteger(value)) fail('integer overflow'); return value; }
  function encodeUInt(value, width) {
    if (!Number.isSafeInteger(value) || value < 0) fail('invalid integer value');
    if (!width) { width = 1; while (value >= 256 ** width) width++; }
    const bytes = new Uint8Array(width);
    for (let i = width - 1; i >= 0; i--) { bytes[i] = value % 256; value = Math.floor(value / 256); }
    if (value) fail('integer does not fit');
    return bytes;
  }
  function size(value) {
    let width = 1; while (value >= 2 ** (7 * width) - 1) width++;
    if (width > 8) fail('container too large');
    const bytes = encodeUInt(value, width); bytes[0] |= 2 ** (8 - width); return bytes;
  }
  function join(parts) { const output = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0; for (const p of parts) { output.set(p, offset); offset += p.length; } return output; }
  function element(id, payload) { return join([encodeUInt(id), size(payload.length), payload]); }
  const number = (id, value, width) => element(id, encodeUInt(value, width));
  function float(id, value) { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setFloat64(0, value); return element(id, bytes); }
  function parseChildren(bytes) {
    const children = []; let offset = 0;
    while (offset < bytes.length) {
      const id = vint(bytes, offset, true), length = vint(bytes, offset + id.width);
      const dataStart = offset + id.width + length.width, end = dataStart + length.value;
      if (length.unknown || end > bytes.length) fail('truncated metadata element');
      children.push({ id: id.value, raw: bytes.subarray(offset, end), data: bytes.subarray(dataStart, end) }); offset = end;
    }
    return children;
  }
  async function finalize(blob, options = {}) {
    const signal = options.signal;
    let cacheStart = -1, cache = new Uint8Array();
    const check = () => { if (signal?.aborted) throw new Error('Recording metadata cancelled'); };
    async function read(offset, count) {
      check(); if (offset < 0 || count < 0 || offset + count > blob.size) fail('truncated recording');
      if (count > 65536) { const result = new Uint8Array(await blob.slice(offset, offset + count).arrayBuffer()); check(); return result; }
      if (offset < cacheStart || offset + count > cacheStart + cache.length) {
        cacheStart = offset; cache = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + 65536)).arrayBuffer()); check();
      }
      return cache.subarray(offset - cacheStart, offset - cacheStart + count);
    }
    async function header(offset, limit) {
      const bytes = await read(offset, Math.min(12, limit - offset));
      const id = vint(bytes, 0, true), length = vint(bytes, id.width), start = offset + id.width + length.width;
      const end = length.unknown ? limit : start + length.value;
      if (end > limit || start > limit) fail('truncated element');
      return { id: id.value, offset, start, end, unknown: length.unknown };
    }
    const ebml = await header(0, blob.size);
    if (ebml.id !== ID.EBML || ebml.unknown || ebml.end - ebml.start > 65536) fail('missing EBML header');
    const segment = await header(ebml.end, blob.size);
    if (segment.id !== ID.SEGMENT) fail('missing Segment');
    // MediaRecorder writes an open Segment. Recover files previously damaged by
    // the first-chunk fixer as well: later complete Clusters still belong to it.
    const limit = blob.size;
    const entries = []; let cursor = segment.start, info, tracks;
    while (cursor < limit) {
      const entry = await header(cursor, limit);
      if (entry.id === ID.CLUSTER) {
        let pos = entry.start;
        while (pos < entry.end) {
          const child = await header(pos, entry.end);
          if (entry.unknown && levelOne.has(child.id)) break;
          if (child.unknown) fail('unsupported open cluster child');
          pos = child.end;
        }
        entry.end = pos;
      } else if (entry.unknown) fail('unsupported open metadata element');
      if (entry.end <= cursor) fail('non-advancing container');
      if (entry.id === ID.INFO) { if (info) fail('multiple Info elements'); info = entry; }
      if (entry.id === ID.TRACKS) { if (tracks) fail('multiple Tracks elements'); tracks = entry; }
      if (![ID.SEEK, ID.CUES, 0xbf].includes(entry.id)) entries.push(entry);
      cursor = entry.end;
    }
    if (!info || !tracks || info.end - info.start > 1048576 || tracks.end - tracks.start > 1048576) fail('missing or oversized track metadata');
    const infoChildren = parseChildren(await read(info.start, info.end - info.start));
    const scale = uint(infoChildren.find(child => child.id === 0x2ad7b1)?.data || new Uint8Array([15, 66, 64]));
    if (!scale) fail('invalid TimestampScale');
    const trackInfo = new Map();
    for (const entry of parseChildren(await read(tracks.start, tracks.end - tracks.start)).filter(child => child.id === 0xae)) {
      const children = parseChildren(entry.data), value = id => children.find(child => child.id === id)?.data;
      const id = uint(value(0xd7) || new Uint8Array());
      if (!id || trackInfo.has(id)) fail('invalid track number');
      const codec = String.fromCharCode(...(value(0x86) || []));
      trackInfo.set(id, { type: uint(value(0x83) || new Uint8Array()), codec,
        duration: value(0x23e383) ? uint(value(0x23e383)) / scale : 0 });
    }
    const video = [...trackInfo].find(([, track]) => track.type === 1)?.[0];
    const cueTrack = video || [...trackInfo].find(([, track]) => track.type === 2)?.[0];
    if (!cueTrack) fail('no playable media tracks');
    let duration = 0, blocks = 0;
    const cues = [], lastTimes = new Map();
    async function block(entry, timestamp, cluster, groupDuration, keyframe, cueOffset = entry.offset) {
      const prefix = await read(entry.start, Math.min(16, entry.end - entry.start));
      const track = vint(prefix, 0), p = track.width;
      if (prefix.length < p + 3 || track.unknown || !trackInfo.has(track.value)) fail('invalid media block');
      let relative = prefix[p] * 256 + prefix[p + 1]; if (relative >= 32768) relative -= 65536;
      const time = timestamp + relative, spec = trackInfo.get(track.value), flags = prefix[p + 2];
      if (time < 0) fail('negative media timestamp');
      const lace = (flags & 6) >> 1, frames = lace ? (prefix[p + 3] ?? 0) + 1 : 1;
      let tail = groupDuration || spec.duration * frames;
      if (!lace && spec.codec === 'A_OPUS' && prefix.length > p + 3) {
        const toc = prefix[p + 3], config = toc >> 3;
        const ms = config < 12 ? [10, 20, 40, 60][config % 4] : config < 16 ? [10, 20][config % 2] : [2.5, 5, 10, 20][config % 4];
        const count = (toc & 3) === 0 ? 1 : (toc & 3) === 3 ? (prefix[p + 4] || 0) & 63 : 2;
        tail = ms * count * 1000000 / scale;
      }
      const previous = lastTimes.get(track.value);
      if (!tail && previous !== undefined && time > previous) tail = time - previous;
      lastTimes.set(track.value, time);
      duration = Math.max(duration, time + tail); blocks++;
      if (track.value === cueTrack && (video ? keyframe ?? !!(flags & 128) : !cluster.cued)) {
        cues.push({ time, cluster, relative: cueOffset - cluster.start }); cluster.cued = true;
      }
    }
    for (const cluster of entries.filter(entry => entry.id === ID.CLUSTER)) {
      let pos = cluster.start, timestamp = null;
      while (pos < cluster.end) {
        const child = await header(pos, cluster.end);
        if (child.unknown) fail('unsupported cluster child');
        if (child.id === 0xe7) timestamp = uint(await read(child.start, child.end - child.start));
        else if ([0xa3, 0xa0].includes(child.id)) {
          if (timestamp === null) fail('cluster has no timestamp');
          if (child.id === 0xa3) await block(child, timestamp, cluster);
          else {
            let p = child.start, media, span = 0, reference = false;
            while (p < child.end) {
              const member = await header(p, child.end); if (member.unknown) fail('unsupported BlockGroup child');
              if (member.id === 0xa1) media = member;
              if (member.id === 0x9b) span = uint(await read(member.start, member.end - member.start));
              if (member.id === 0xfb) reference = true;
              p = member.end;
            }
            if (!media) fail('BlockGroup has no Block');
            await block(media, timestamp, cluster, span, !reference, child.offset);
          }
        }
        pos = child.end;
      }
    }
    if (!blocks || !duration || !cues.length) fail('no complete seekable media');
    const newInfo = element(ID.INFO, join([...infoChildren.filter(child => ![0x4489, 0xbf].includes(child.id)).map(child => child.raw), float(0x4489, duration)]));
    const h264 = [...trackInfo.values()].some(track => !['V_VP8', 'V_VP9', 'V_AV1', 'A_OPUS', 'A_VORBIS'].includes(track.codec));
    const ebmlChildren = parseChildren(await read(ebml.start, ebml.end - ebml.start));
    const originalDocType = String.fromCharCode(...(ebmlChildren.find(child => child.id === 0x4282)?.data || []));
    const matroska = h264 || originalDocType === 'matroska';
    const newEbml = element(ID.EBML, join(ebmlChildren.filter(child => child.id !== 0xbf).map(child => child.id === 0x4282 && matroska
      ? element(0x4282, new Uint8Array([... 'matroska'].map(c => c.charCodeAt(0)))) : child.raw)));
    const seek = positions => element(ID.SEEK, join([ID.INFO, ID.TRACKS, ID.CUES].map(id => element(0x4dbb,
      join([element(0x53ab, encodeUInt(id)), number(0x53ac, positions.get(id) || 0, 8)])))));
    const positions = new Map(), parts = []; let offset = seek(positions).length;
    for (const entry of entries) {
      entry.position = offset; positions.set(entry.id, offset);
      const part = entry.id === ID.INFO ? newInfo : entry.id === ID.CLUSTER
        ? new Blob([encodeUInt(ID.CLUSTER), size(entry.end - entry.start), blob.slice(entry.start, entry.end)])
        : blob.slice(entry.offset, entry.end);
      parts.push(part); offset += part.size ?? part.length;
    }
    positions.set(ID.CUES, offset);
    cues.sort((a, b) => a.time - b.time);
    const newCues = element(ID.CUES, join(cues.map(cue => element(0xbb, join([
      number(0xb3, Math.floor(cue.time)), element(0xb7, join([number(0xf7, cueTrack),
        number(0xf1, cue.cluster.position, 8), number(0xf0, cue.relative)])),
    ])))));
    const body = new Blob([seek(positions), ...parts, newCues]);
    const type = matroska ? 'video/x-matroska' : video ? 'video/webm' : 'audio/webm';
    check();
    return { blob: new Blob([newEbml, encodeUInt(ID.SEGMENT), size(body.size), body], { type }),
      durationMs: duration * scale / 1000000, extension: matroska ? 'mkv' : 'webm', blocks, cues: cues.length };
  }
  window.MeetBudyMetadata = { finalize };
})();
