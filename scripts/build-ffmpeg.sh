#!/usr/bin/env bash
# The autoclipper's ffmpeg: a cut-only build, a few MB instead of ~80.
#
# Trimming a clip is a stream copy (`-sseof -N -i in -c copy out`): no decoding,
# no encoding. So everything is disabled except reading and writing the
# containers OBS records (mp4 / fragmented mp4 / mov, mkv, flv, mpegts), the
# parsers that find keyframes and timestamps in the streams, and the file
# protocol. No encoders or decoders, no network, no hardware, nothing GPL - an
# LGPL build, which is what lets it ship inside an MIT app (with the notice and
# source pointer written next to it, see below).
#
#   scripts/build-ffmpeg.sh win64    cross-compile ffmpeg.exe (CI: ubuntu + mingw-w64)
#   scripts/build-ffmpeg.sh native   this machine, for testing the flags locally
#
# Output: vendor/ffmpeg/ (ffmpeg or ffmpeg.exe, LICENSE.md, SOURCE.md)
set -euo pipefail

VERSION=7.1.1
# Checked against the tarball's signature by FFmpeg's release signing key
# (FCF986EA15E6E293A5644F10B4322F04D67658D8), 2026-10-14.
SHA256=733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1
URL="https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz"

TARGET="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${FFMPEG_WORK:-$ROOT/build/ffmpeg-src}"
OUT="$ROOT/vendor/ffmpeg"

case "$TARGET" in
  win64) CROSS=(--arch=x86_64 --target-os=mingw32 --cross-prefix=x86_64-w64-mingw32- --enable-cross-compile --extra-ldflags=-static) ; BIN=ffmpeg.exe ;;
  native) CROSS=() ; BIN=ffmpeg ;;
  *) echo "usage: $0 win64|native" >&2 ; exit 2 ;;
esac

mkdir -p "$WORK" "$OUT"
cd "$WORK"
if [ ! -f "ffmpeg-${VERSION}.tar.xz" ]; then curl -fsSLO "$URL"; fi
echo "${SHA256}  ffmpeg-${VERSION}.tar.xz" | shasum -a 256 -c -
rm -rf "ffmpeg-${VERSION}"
tar xf "ffmpeg-${VERSION}.tar.xz"
cd "ffmpeg-${VERSION}"

# Kept in one array so SOURCE.md records exactly what was built.
FLAGS=(
  --disable-everything --disable-autodetect --disable-network --disable-doc
  --disable-programs --enable-ffmpeg
  --disable-shared --enable-static --enable-small --disable-debug --disable-x86asm
  --enable-protocol=file,pipe
  --enable-demuxer=mov,matroska,flv,mpegts
  --enable-muxer=mp4,mov,matroska,flv,mpegts
  --enable-parser=h264,hevc,av1,aac,opus
  --enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,extract_extradata,null
  # the one decoder: in mpegts the audio's sample rate is only learned by decoding
  # a frame of it ("sample rate not set" otherwise). AAC is what OBS records.
  --enable-decoder=aac
  # the ffmpeg CLI wants a scaler/resampler and the stream-copy filter graph even
  # when nothing is decoded; these are the null/passthrough pieces
  --enable-filter=null,anull,copy,acopy
  --enable-swresample --enable-swscale
)
# ${CROSS[@]+...}: an empty array is "unbound" under set -u in bash 3.2 (macOS)
./configure "${FLAGS[@]}" ${CROSS[@]+"${CROSS[@]}"}
# the make target carries the exe suffix: under mingw it's ffmpeg.exe, not ffmpeg
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)" "$BIN"
cp "$BIN" "$OUT/$BIN"
cp COPYING.LGPLv2.1 "$OUT/LICENSE.md"
cat > "$OUT/SOURCE.md" <<EOF
# ffmpeg used by kova companion's autoclipper

FFmpeg ${VERSION}, unmodified source: ${URL}
(sha256 ${SHA256}), licensed under the LGPL v2.1 - see LICENSE.md.

Built by scripts/build-ffmpeg.sh in https://github.com/pyvnoaim/kova-companion
with these configure flags, nothing else:

    ${FLAGS[*]}
EOF
echo "built $OUT/$BIN ($(du -h "$OUT/$BIN" | cut -f1))"
