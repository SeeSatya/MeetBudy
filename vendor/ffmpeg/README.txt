FFmpeg.wasm core files required for single-file multi-track MKV mux.

If these files are not present, Meet Budy still works — recording produces
N separate files (one main MKV + one .webm per extra audio track). Adding
ffmpeg here ALSO produces a single combined MKV with every track inside it,
and incidentally fixes the WMP/VLC "jumpy seekbar / only first chunk plays"
problem because ffmpeg rewrites cluster timestamps and the cues index.

──────────────────────────────────────────────────────────────────────────
DOWNLOAD THESE THREE FILES, RENAME EXACTLY AS LISTED, PLACE IN THIS FOLDER:
──────────────────────────────────────────────────────────────────────────

1. ffmpeg-core.js
2. ffmpeg-core.wasm
3. ffmpeg-core.worker.js

Source: @ffmpeg/core v0.12.6 (or newer 0.12.x). Two easy ways to get them:

  A) From unpkg:
     https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js
     https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm
     https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.worker.js

  B) From npm:
     npm pack @ffmpeg/core@0.12.6
     (extract the tarball and copy the three files from dist/umd/)

After dropping the files here, reload the extension. On the next recording
stop you'll get one extra file: meet-recording-<ts>_combined.mkv with all
audio tracks muxed in.

If you ever want to disable muxing, just delete these three files.
