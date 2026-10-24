#!/usr/bin/env python3
"""Download Waymark footage as a training dataset.

For every recording you get the video plus a telemetry CSV (time, position,
speed, heading, GPS accuracy). With --fps, frames are extracted (needs
ffmpeg) and frames.csv labels every frame with the same values, ready for
training.

  # your own footage (file from the site: Mine > Download for AI training)
  python waymark_export.py --manifest waymark-export.json --out data --fps 2

  # all public footage in an area: west,south,east,north
  python waymark_export.py --bbox -74.02,40.70,-73.93,40.80 --out data --fps 2

Output:
  data/manifest.json                 everything the server returned
  data/<id>/video.mp4|webm           the footage
  data/<id>/telemetry.csv            one row per GPS fix
  data/<id>/frames/000001.jpg ...    with --fps
  data/frames.csv                    one row per frame, all recordings
"""
import argparse, csv, json, math, os, shutil, subprocess, sys, urllib.parse, urllib.request

API = 'https://waymark-api.axion-collect.workers.dev'
UA = {'User-Agent': 'waymark-export/1.0'}


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return json.load(r)


def download(url, path, size=None):
    if size and os.path.exists(path) and os.path.getsize(path) == size:
        return False  # already have it
    tmp = path + '.part'
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r, open(tmp, 'wb') as f:
        shutil.copyfileobj(r, f, 1 << 20)
    os.replace(tmp, path)
    return True


def dist_m(a, b):
    r = math.pi / 180
    dlat, dlng = (b[0] - a[0]) * r, (b[1] - a[1]) * r
    h = math.sin(dlat / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin(dlng / 2) ** 2
    return 2 * 6371000 * math.asin(min(1, math.sqrt(h)))


def bearing(a, b):
    r = math.pi / 180
    y = math.sin((b[1] - a[1]) * r) * math.cos(b[0] * r)
    x = math.cos(a[0] * r) * math.sin(b[0] * r) - math.sin(a[0] * r) * math.cos(b[0] * r) * math.cos((b[1] - a[1]) * r)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def telemetry(track):
    """One row per GPS fix, with speed and heading derived from the track
    (smoothed over about 2 s / 10 m) next to the phone's own values."""
    pts = [dict(t=p[0], lat=p[1], lng=p[2], acc=p[3] if len(p) > 3 else None,
                gps_speed=p[4] if len(p) > 4 else None, gps_heading=p[5] if len(p) > 5 else None) for p in track]
    pts.sort(key=lambda p: p['t'])
    d = 0.0
    for i, p in enumerate(pts):
        if i:
            d += dist_m((pts[i - 1]['lat'], pts[i - 1]['lng']), (p['lat'], p['lng']))
        p['dist'] = d
    for i, p in enumerate(pts):
        lo = next((j for j in range(i, -1, -1) if p['t'] - pts[j]['t'] >= 1.0), 0)
        hi = next((j for j in range(i, len(pts)) if pts[j]['t'] - p['t'] >= 1.0), len(pts) - 1)
        dt = pts[hi]['t'] - pts[lo]['t']
        p['speed'] = (pts[hi]['dist'] - pts[lo]['dist']) / dt if dt > 0 else 0.0
        a = next((q for q in reversed(pts[:i + 1]) if p['dist'] - q['dist'] >= 10), pts[0])
        b = next((q for q in pts[i:] if q['dist'] - p['dist'] >= 10), pts[-1])
        p['heading'] = bearing((a['lat'], a['lng']), (b['lat'], b['lng'])) if dist_m((a['lat'], a['lng']), (b['lat'], b['lng'])) > 2 else None
    return pts


def at_time(pts, t):
    """Linear interpolation of the telemetry at video time t."""
    if t <= pts[0]['t']:
        return pts[0]
    for a, b in zip(pts, pts[1:]):
        if a['t'] <= t <= b['t']:
            f = (t - a['t']) / (b['t'] - a['t']) if b['t'] > a['t'] else 0
            out = {k: a[k] + (b[k] - a[k]) * f if isinstance(a[k], (int, float)) and isinstance(b[k], (int, float)) else a[k] for k in a}
            if a['heading'] is not None and b['heading'] is not None:  # interpolate across 360 -> 0
                out['heading'] = (a['heading'] + ((b['heading'] - a['heading'] + 180) % 360 - 180) * f) % 360
            out['t'] = t
            return out
    return pts[-1]


def fmt(v, n=2):
    return '' if v is None else round(v, n)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--manifest', help='waymark-export.json downloaded from the site')
    ap.add_argument('--ids', help='comma-separated recording ids')
    ap.add_argument('--bbox', help='public footage in west,south,east,north')
    ap.add_argument('--out', default='waymark-data')
    ap.add_argument('--fps', type=float, default=0, help='extract this many frames per second (needs ffmpeg)')
    ap.add_argument('--api', default=API)
    a = ap.parse_args()

    if a.manifest:
        with open(a.manifest) as f:
            data = json.load(f)
    elif a.ids or a.bbox:
        q = {k: v for k, v in (('ids', a.ids), ('bbox', a.bbox)) if v}
        data = get_json(f"{a.api}/api/export?{urllib.parse.urlencode(q)}")
    else:
        ap.error('give --manifest, --ids or --bbox')
    recs = data.get('recordings', [])
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, 'manifest.json'), 'w') as f:
        json.dump(data, f, indent=1)
    print(f'{len(recs)} recordings')
    ffmpeg = shutil.which('ffmpeg')
    if a.fps and not ffmpeg:
        print('ffmpeg not found: skipping frame extraction (install it, then run again)', file=sys.stderr)

    frame_rows = []
    for n, r in enumerate(recs, 1):
        rid = r['id']
        d = os.path.join(a.out, rid)
        os.makedirs(d, exist_ok=True)
        ext = 'mp4' if 'mp4' in (r.get('videoType') or '') else 'webm'
        video = os.path.join(d, f'video.{ext}')
        got = download(r['videoUrl'], video, r.get('videoBytes'))
        pts = telemetry(r['track'])
        with open(os.path.join(d, 'telemetry.csv'), 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(['t_s', 'lat', 'lng', 'accuracy_m', 'speed_mps', 'heading_deg', 'gps_speed_mps', 'gps_heading_deg', 'distance_m'])
            for p in pts:
                w.writerow([fmt(p['t']), fmt(p['lat'], 7), fmt(p['lng'], 7), fmt(p['acc'], 1), fmt(p['speed']), fmt(p['heading'], 1),
                            fmt(p['gps_speed']), fmt(p['gps_heading'], 1), fmt(p['dist'], 1)])
        meta = {k: v for k, v in r.items() if k != 'track'}
        with open(os.path.join(d, 'meta.json'), 'w') as f:
            json.dump(meta, f, indent=1)
        line = f'[{n}/{len(recs)}] {rid}: {"downloaded" if got else "already here"}, {len(pts)} GPS fixes, {r.get("mode")}, {r.get("kind")}'

        if a.fps and ffmpeg:
            fd = os.path.join(d, 'frames')
            os.makedirs(fd, exist_ok=True)
            for old in os.listdir(fd):
                os.remove(os.path.join(fd, old))
            # Pick real frames about 1/fps apart and have ffmpeg report each
            # one's actual timestamp, so labels match the picture exactly.
            sel = f"select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,{1 / a.fps:.6f}-0.001)',showinfo"
            res = subprocess.run([ffmpeg, '-hide_banner', '-y', '-i', video, '-vf', sel, '-vsync', 'vfr', '-q:v', '3',
                                  os.path.join(fd, '%06d.jpg')], capture_output=True, text=True, check=True)
            times = [float(x.split('pts_time:')[1].split()[0]) for x in res.stderr.splitlines() if 'Parsed_showinfo' in x and 'pts_time:' in x]
            files = sorted(x for x in os.listdir(fd) if x.endswith('.jpg'))
            if len(times) != len(files):
                sys.exit(f'{rid}: got {len(files)} frames but {len(times)} timestamps from ffmpeg; not labeling them wrongly')
            for fn, t in zip(files, times):
                p = at_time(pts, t)
                frame_rows.append([os.path.join(rid, 'frames', fn), rid, round(t, 3), fmt(p['lat'], 7), fmt(p['lng'], 7),
                                   fmt(p['speed']), fmt(p['heading'], 1), fmt(p['acc'], 1), r.get('mode'), r.get('kind'), r.get('createdAt')])
            line += f', {len(files)} frames'
        print(line)

    if frame_rows:
        with open(os.path.join(a.out, 'frames.csv'), 'w', newline='') as f:
            w = csv.writer(f)
            w.writerow(['frame', 'recording', 't_s', 'lat', 'lng', 'speed_mps', 'heading_deg', 'accuracy_m', 'mode', 'kind', 'recorded_at_ms'])
            w.writerows(frame_rows)
        print(f'frames.csv: {len(frame_rows)} labeled frames')


if __name__ == '__main__':
    main()
