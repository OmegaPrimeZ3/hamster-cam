#!/usr/bin/env python3
"""
scripts/mask-audit/overlay.py

Build an HTML mask-audit page from the artifacts that audit.sh pulled off
project-server. For each snapshot JPEG we render an inline SVG on top of
the image with the camera's object-mask polygons drawn semi-transparent.

Where a mask polygon overlaps the saved detection bounding box, that
detection would have been discarded by Frigate — that's the smoking gun
for the "recognises then loses" symptom.

Stdlib only — no PyYAML, no Pillow. The YAML parser here is *intentionally*
tiny and tailored to mac-mini/frigate-config.yml's known shape; it is not
a general-purpose YAML lib. If the file grows new constructs, this script
gets a targeted patch.

Inputs:
  <out-dir>/live-config.yml
  <out-dir>/{hamster_cam_1,hamster_cam_2}/*.jpg

Output:
  <out-dir>/index.html
"""
from __future__ import annotations

import html
import re
import sys
from pathlib import Path

# Filename format from audit.sh: <top_score>_<duration_s>_<event_id>.jpg
FNAME_RE = re.compile(r"^(?P<score>[\d.]+)_(?P<dur>[\d.]+)_(?P<eid>[^.]+)\.jpg$")

# Cameras we care about. Add here if the cage grows a third cam.
CAMERAS = ("hamster_cam_1", "hamster_cam_2")


def parse_masks(config_yml: Path) -> dict[str, list[list[float]]]:
    """
    Return {camera_name: [[x1,y1,x2,y2,...], ...]} — one inner list per mask
    polygon. Coordinates are normalized (0..1). Tolerates two shapes seen in
    the live config:

        cameras:
          hamster_cam_1:
            objects:
              mask:
                - 0.5,0.456,0.732,0.997,...

    and the older repo shape (mask nested under filters.hamster). We just
    grab every `mask:` block we find inside each camera section.
    """
    result: dict[str, list[list[float]]] = {c: [] for c in CAMERAS}
    text = config_yml.read_text()

    # Split the file into camera sections by finding each top-level
    # "  <camera_name>:" header inside the `cameras:` block. Indentation in
    # the live config is 2-space; the camera headers live at exactly 4
    # spaces under `cameras:` (the live config Aaron pasted uses that).
    cameras_block_match = re.search(
        r"(?ms)^cameras:\s*\n(.*?)(?=^\S|\Z)",
        text,
    )
    if not cameras_block_match:
        return result
    cameras_block = cameras_block_match.group(1)

    # Find each camera header and the slice of text that follows it, up to
    # the next camera header at the same indent or end of block.
    cam_header_re = re.compile(r"(?m)^  (?P<name>[A-Za-z0-9_]+):\s*$")
    headers = list(cam_header_re.finditer(cameras_block))
    for i, m in enumerate(headers):
        name = m.group("name")
        if name not in result:
            continue
        start = m.end()
        end = headers[i + 1].start() if i + 1 < len(headers) else len(cameras_block)
        cam_text = cameras_block[start:end]

        # Pull every mask block — they look like:
        #   mask:
        #     - 0.5,0.456,...
        #     - 0.165,0.347,...
        # The list items can sit at any indent; we just grab "- <comma list>"
        # lines that follow a "mask:" line, until a non-list line appears.
        for mask_block in re.finditer(
            r"(?ms)^[ \t]*mask:\s*\n(?P<items>(?:[ \t]*-[^\n]*\n)+)",
            cam_text,
        ):
            for line in mask_block.group("items").splitlines():
                m2 = re.match(r"^\s*-\s*(.+?)\s*$", line)
                if not m2:
                    continue
                raw = m2.group(1)
                coords: list[float] = []
                bad = False
                for tok in raw.split(","):
                    tok = tok.strip()
                    try:
                        coords.append(float(tok))
                    except ValueError:
                        bad = True
                        coords.append(float("nan"))
                if bad:
                    # Flag malformed polygons but keep them — overlay.html
                    # will render them in red so the operator sees the typo.
                    print(
                        f"WARN: {name} has a malformed mask polygon: {raw!r}",
                        file=sys.stderr,
                    )
                # Pad odd-length lists so we don't crash; SVG ignores trailing.
                if len(coords) % 2:
                    coords.append(0.0)
                result[name].append(coords)
    return result


def coords_to_svg_points(coords: list[float]) -> str:
    """Turn [x1,y1,x2,y2,...] into 'x1,y1 x2,y2 ...' for SVG <polygon>."""
    pts: list[str] = []
    for i in range(0, len(coords) - 1, 2):
        x, y = coords[i], coords[i + 1]
        # NaN slips through from typos; convert to a visible-but-tagged value.
        if x != x or y != y:  # noqa: PLR0124
            x, y = 0.0, 0.0
        pts.append(f"{x:.4f},{y:.4f}")
    return " ".join(pts)


def render_tile(cam: str, jpg: Path, polys: list[list[float]]) -> str:
    """Render one snapshot tile as a self-contained HTML block."""
    m = FNAME_RE.match(jpg.name)
    score = m.group("score") if m else "?"
    dur = m.group("dur") if m else "?"
    eid = m.group("eid") if m else jpg.stem

    # Relative path from <out>/index.html → <out>/<cam>/<file>.jpg
    rel = f"{cam}/{jpg.name}"

    # Highlight short events with low scores — the most likely flicker.
    try:
        flicker = float(dur) < 3.0 and float(score) < 0.75
    except ValueError:
        flicker = False
    flicker_cls = " tile--flicker" if flicker else ""

    polys_svg = "\n".join(
        f'<polygon points="{coords_to_svg_points(p)}" '
        f'fill="rgba(255,40,40,0.28)" stroke="rgba(255,40,40,0.95)" '
        f'stroke-width="0.004" />'
        for p in polys
    )

    return f"""
<div class="tile{flicker_cls}">
  <div class="tile__wrap">
    <img loading="lazy" src="{html.escape(rel)}" alt="{html.escape(eid)}">
    <svg class="tile__overlay" viewBox="0 0 1 1" preserveAspectRatio="none">
      {polys_svg}
    </svg>
  </div>
  <div class="tile__meta">
    <span class="tile__score">score {html.escape(score)}</span>
    <span class="tile__dur">dur {html.escape(dur)}s</span>
    <span class="tile__id">{html.escape(eid)}</span>
  </div>
</div>
"""


def render_camera_section(cam: str, jpgs: list[Path], polys: list[list[float]]) -> str:
    tiles = "\n".join(render_tile(cam, j, polys) for j in jpgs)
    return f"""
<section class="cam">
  <h2>{html.escape(cam)} <small>({len(jpgs)} events, {len(polys)} mask polygons)</small></h2>
  <div class="grid">
    {tiles or '<p class="empty">No events in window.</p>'}
  </div>
</section>
"""


HTML_TMPL = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Frigate mask audit</title>
<style>
  body {{ font-family: -apple-system, sans-serif; margin: 0; padding: 1.5rem; background:#111; color:#eee; }}
  h1 {{ margin-top:0; }}
  h2 {{ margin-top:2rem; font-weight:500; }}
  h2 small {{ color:#999; font-weight:400; font-size:.7em; margin-left:.5em; }}
  .legend {{ background:#222; padding:.75rem 1rem; border-radius:6px; font-size:.9em; line-height:1.55; }}
  .legend code {{ background:#000; padding:.05em .35em; border-radius:3px; }}
  .grid {{ display:grid; grid-template-columns: repeat(auto-fill, minmax(320px,1fr)); gap:1rem; margin-top:.5rem; }}
  .tile {{ background:#1a1a1a; border-radius:6px; overflow:hidden; border:1px solid #2a2a2a; }}
  .tile--flicker {{ border-color:#a64; box-shadow:0 0 0 1px #a64 inset; }}
  .tile__wrap {{ position:relative; aspect-ratio: 16/9; background:#000; }}
  .tile__wrap img {{ position:absolute; inset:0; width:100%; height:100%; object-fit:contain; }}
  .tile__overlay {{ position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }}
  .tile__meta {{ padding:.4rem .6rem; font-size:.78em; display:flex; gap:.75rem; color:#bbb; font-family: ui-monospace, monospace; }}
  .tile__id {{ margin-left:auto; opacity:.6; }}
  .empty {{ color:#777; }}
</style>
</head>
<body>
<h1>Frigate mask audit</h1>
<div class="legend">
  <strong>Red shaded regions</strong> = current object-mask polygons (Frigate
  <em>discards</em> any detection inside them). Each tile shows the
  snapshot Frigate saved for one event, with the masks overlaid in red and
  Frigate's saved bounding box drawn in the JPEG itself.
  <br><br>
  <strong>Orange-bordered tiles</strong> = likely-flicker events
  (<code>duration &lt; 3s</code> AND <code>top_score &lt; 0.75</code>) — the
  ones most worth inspecting first. If you see those clustered along a
  mask boundary, the masks are eating real tracks.
</div>
{sections}
</body>
</html>
"""


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: overlay.py <out-dir>", file=sys.stderr)
        sys.exit(2)
    out = Path(sys.argv[1])
    cfg = out / "live-config.yml"
    if not cfg.exists():
        print(f"ERR: {cfg} missing — did audit.sh succeed?", file=sys.stderr)
        sys.exit(1)

    masks = parse_masks(cfg)

    sections: list[str] = []
    for cam in CAMERAS:
        cam_dir = out / cam
        jpgs = sorted(
            (p for p in cam_dir.glob("*.jpg")),
            # Lowest top_score first — those are the most likely flickers.
            key=lambda p: float(FNAME_RE.match(p.name).group("score")) if FNAME_RE.match(p.name) else 1.0,
        )
        sections.append(render_camera_section(cam, jpgs, masks.get(cam, [])))

    (out / "index.html").write_text(HTML_TMPL.format(sections="\n".join(sections)))


if __name__ == "__main__":
    main()
