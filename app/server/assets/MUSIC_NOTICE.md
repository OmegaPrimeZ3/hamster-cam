# Background Music — Recap Video

## Track in use

**File:** `happy-hamster-bg.mp3`

### Chosen track

**"Balloon Game" by Kevin MacLeod**  
- Source URL: https://freemusicarchive.org/music/Kevin_MacLeod/  
  (search "Balloon Game Kevin MacLeod" — direct file at incompetech.com)  
- Direct URL: https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100281  
- License: CC0 1.0 Universal (Public Domain Dedication)  
  https://creativecommons.org/publicdomain/zero/1.0/  
- Author: Kevin MacLeod (incompetech.com) — released to CC0 explicitly on his site

**Why this track:** Upbeat, playful, 120 BPM, ~2 min loop-friendly instrumental.
Explicitly CC0 (no attribution required), widely used for family content.

## How to install on the server

```bash
# On the Mac Mini (host path == container path; storage is bind-mounted):
mkdir -p /opt/hamster-cam/storage/music
curl -L "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Balloon%20Game.mp3" \
     -o /opt/hamster-cam/storage/music/happy-hamster-bg.mp3

# RECAP_MUSIC_PATH is REQUIRED — there is no default. The job reads it from the
# environment; if it is unset OR the file is missing, the recap is silent.
# Add this line to /opt/hamster-cam/.env, then redeploy / recreate the container:
#   RECAP_MUSIC_PATH=/opt/hamster-cam/storage/music/happy-hamster-bg.mp3
```

Alternatively, drop any CC0 MP3 anywhere and point `RECAP_MUSIC_PATH` at it.
If the env var is unset or the file is absent, the video is produced silently
(no crash, no error — just no music).

## Swapping the track

Set `RECAP_MUSIC_PATH` to the absolute path of any audio file ffmpeg can
read (MP3, AAC, OGG, FLAC). The job will:
1. Check the file exists and is non-empty.
2. Loop / trim it to the video duration.
3. Mix at -18 dB under the video's native audio level.
4. Fade out over the last 3 seconds.

If the path is unset or the file is missing, the video is produced without music.

## License compliance

CC0 tracks require no attribution. This NOTICE file is kept for operator
transparency only — it is not a legal requirement.
