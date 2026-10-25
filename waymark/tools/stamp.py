#!/usr/bin/env python3
"""Give every app file link a version (?v=...) so phones load new code right
after a deploy instead of a cached copy. Run before committing a change:

  python3 waymark/tools/stamp.py
"""
import glob, os, re, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V = time.strftime('%Y%m%d%H%M', time.gmtime())

def stamp(path, pattern):
    s = open(path).read()
    t = re.sub(pattern, lambda m: f"{m.group(1)}?v={V}{m.group(3)}", s)
    if t != s:
        open(path, 'w').write(t)

# import ... from './x.js'  and  import('./x.js')
for f in glob.glob(os.path.join(ROOT, 'js', '*.js')):
    stamp(f, r"""((?:from\s+|import\()['"]\.\.?/[\w/.-]+?\.js)(\?v=\w+)?(['"])""")
idx = os.path.join(ROOT, 'index.html')
stamp(idx, r"""((?:src|href)="(?:js/app\.js|styles\.css))(\?v=\w+)?(")""")
s = open(idx).read()
s = re.sub(r'(<span id="appVersion">)[^<]*(</span>)', rf'\g<1>{V}\g<2>', s)
open(idx, 'w').write(s)
print('version', V)
