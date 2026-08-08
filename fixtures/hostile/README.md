# Hostile corpus

Tiny adversarial inputs the E3 security tests (docs/DECISIONS.md **D-032**) drive through
the real `probe`/`extract` code path to prove the ffmpeg/ffprobe protocol whitelist (S-1)
closes the passive-input attack surface. Everything here is bytes, not media — a dropped
"media" file the product accepts by design (§4.1 rejects nothing by extension), crafted to
make an unguarded ffmpeg reach outside the file it was handed.

| File | Vector | What a guarded probe/extract must do |
| --- | --- | --- |
| `local-file-disclosure.ffconcat` | Concat demuxer script referencing absolute `file://` / local paths | **Refuse** — `-safe 1` / concat safe-mode rejects the unsafe names; `/etc/passwd` is never read into the output. |
| `ssrf.m3u8` | HLS playlist whose segments are remote URLs (loopback + the `169.254.169.254` cloud metadata address) | **Refuse** — `-protocol_whitelist file` blocks `http`, so no outbound request is made. |
| `malformed.bin` | Garbage that ffprobe will parse and reject | Land in `unsynced` as an ordinary decode failure, never a panic. |

The leading-dash filename (S-2, argument injection) and control-character filename (S-3,
FCPXML illegal-char stripping) are constructed at test time rather than committed, because
a file literally named `-show_data_hex` or containing a `\x07` is awkward to carry in git.
