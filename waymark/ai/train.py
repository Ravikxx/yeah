# Train a small driving model on Waymark footage and test it on held-out data.
#
# Inputs per frame: ResNet-18 image features (now and 1 s ago), what a
# COCO-pretrained detector sees (stop sign / traffic light: score and size),
# and what the navigation said (next turn left/right/arrive, metres to it).
# Targets, all from your own riding:
#   speed      how fast to go here (m/s)
#   stop_soon  whether you came to a stop within the next 3 s
#   turn       left / straight / right over the next 3 s
# Two tests: held-out recordings, and a held-out area of town (the strict
# one: none of those streets were seen in training).
import csv, json, math, sys
import numpy as np
from sklearn.neural_network import MLPRegressor, MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA
from sklearn.ensemble import HistGradientBoostingRegressor, HistGradientBoostingClassifier
from PIL import Image
from sklearn.metrics import mean_absolute_error, roc_auc_score, balanced_accuracy_score

rows = list(csv.DictReader(open('data/frames.csv')))
F = np.load('feats.npy')
dets = {d['frame']: d['dets'] for d in json.load(open('dets.json'))}

by = {}
for i, r in enumerate(rows):
    r['i'] = i
    by.setdefault(r['recording'], []).append(r)
for rs in by.values():
    rs.sort(key=lambda r: float(r['t_s']))

def f(v, d=0.0):
    try: return float(v)
    except (TypeError, ValueError): return d

SIZES = {}
def size_of(frame):  # frames are 720x1280 or 480x640 depending on the phone/settings
    if frame not in SIZES:
        SIZES[frame] = Image.open('data/' + frame).size
    return SIZES[frame]

def nav_feats(r):
    """What the navigation was telling you at this moment (destination trips only):
    which way the next instruction turns and how far away it is."""
    ins = r.get('instruction', '').lower()
    has = 1.0 if ins else 0.0
    d = f(r.get('instruction_in_m'), 999.0) if ins else 999.0
    kind = [ins.startswith('turn left') or 'slight left' in ins or 'sharp left' in ins or (ins.startswith('keep left')),
            ins.startswith('turn right') or 'slight right' in ins or 'sharp right' in ins or ins.startswith('keep right'),
            'u-turn' in ins, ins.startswith('arrive'), ins.startswith('off route')]
    kind = [float(k) for k in kind]
    near = 1.0 if d < 40 else 0.0
    left = f(r.get('destination_in_m'), 9999.0) if ins else 9999.0
    return [has, *kind, min(d, 999.0), near * kind[0], near * kind[1], min(left, 9999.0)]

def follow_directions(prob):
    p = prob.copy()
    for j, r in enumerate(ordered):
        n = nav_feats(r)
        if n[6] < 30 and (n[1] or n[2]):
            p[j] = [0.75, 0.25, 0] if n[1] else [0, 0.25, 0.75]
    return p

def turn_class(h0, h1):
    if h0 is None or h1 is None: return 1
    d = (h1 - h0 + 540) % 360 - 180
    return 0 if d < -35 else 2 if d > 35 else 1

X, Y_speed, Y_stop, Y_turn, rec, lat, lng = [], [], [], [], [], [], []
ordered = []
for rid, rs in by.items():
    for k, r in enumerate(rs):
        i = r['i']
        prev = rs[k - 1]['i'] if k else i
        W, H = size_of(r['frame'])
        dd = [x for x in dets.get(r['frame'], []) if (x['box'][1] + x['box'][3]) / 2 < H * 0.75 and x['score'] >= 0.5]
        det = []
        for cls in ('stop_sign', 'traffic_light'):
            ds = [x for x in dd if x['cls'] == cls]
            best = max(ds, key=lambda x: x['score'], default=None)
            area = ((best['box'][2] - best['box'][0]) * (best['box'][3] - best['box'][1]) / (W * H)) if best else 0
            det += [best['score'] if best else 0, math.sqrt(area)]
        # 3 s ahead
        fut = [x for x in rs[k + 1:k + 4]]
        sp = f(r['speed_mps'])
        # Slowing for something ahead: within the next 8 s, speed drops below
        # 60% of now (or to a stop). Stop signs are usually seen 4-8 s early.
        ahead8 = [f(x['speed_mps']) for x in rs[k + 1:k + 9]]
        stop_soon = int(sp > 2.0 and bool(ahead8) and min(ahead8) < max(1.0, 0.6 * sp))
        h0 = f(r['heading_deg'], None) if r['heading_deg'] else None
        h1 = f(fut[-1]['heading_deg'], None) if fut and fut[-1]['heading_deg'] else None
        recent = [x for q in rs[max(0, k - 2):k + 1] for x in dets.get(q['frame'], []) if x['cls'] == 'stop_sign' and x['score'] >= 0.5 and (x['box'][1] + x['box'][3]) / 2 < size_of(q['frame'])[1] * 0.75]
        det += [max([x['score'] for x in recent], default=0), len(recent)]
        r['_stop_sign_seen'] = bool(recent)
        X.append(np.concatenate([F[i], F[i] - F[prev], det, [det[0] * 10, det[4] * 10, det[5]], nav_feats(r)]))
        Y_speed.append(sp); Y_stop.append(stop_soon); Y_turn.append(turn_class(h0, h1))
        rec.append(rid); lat.append(f(r['lat'])); lng.append(f(r['lng'])); ordered.append(r)
X = np.array(X, np.float32); Y_speed = np.array(Y_speed); Y_stop = np.array(Y_stop); Y_turn = np.array(Y_turn)
rec = np.array(rec); lng = np.array(lng)
print(f'{len(X)} frames, {len(by)} recordings | slowing-within-8s positives {Y_stop.sum()} | turns L/S/R {np.bincount(Y_turn, minlength=3)}')

def run(name, test):
    train = ~test
    # Image features squeezed to 32 numbers; detector signals kept as-is so they aren't drowned out.
    IMG = 1024
    sc = StandardScaler().fit(X[train][:, :IMG]); pca = PCA(32, random_state=0).fit(sc.transform(X[train][:, :IMG]))
    P = lambda m: np.hstack([pca.transform(sc.transform(X[m][:, :IMG])), X[m][:, IMG:]])
    Xtr, Xte = P(train), P(test)
    Xall = P(np.ones(len(X), bool))
    out = {'split': name, 'train_frames': int(train.sum()), 'test_frames': int(test.sum())}
    GB = dict(max_iter=200, learning_rate=0.05, max_leaf_nodes=15, l2_regularization=1.0, random_state=0)
    reg = HistGradientBoostingRegressor(**GB).fit(Xtr, Y_speed[train])
    pred = np.clip(reg.predict(Xte), 0, None)
    out['speed_MAE_mps'] = round(mean_absolute_error(Y_speed[test], pred), 2)
    out['speed_MAE_baseline'] = round(mean_absolute_error(Y_speed[test], np.full(test.sum(), Y_speed[train].mean())), 2)
    if Y_stop[test].sum() and Y_stop[train].sum():
        clf = clf_stop = HistGradientBoostingClassifier(**GB, class_weight='balanced').fit(Xtr, Y_stop[train])
        out['stop_soon_AUC'] = round(roc_auc_score(Y_stop[test], clf.predict_proba(Xte)[:, 1]), 3)
        out['stop_soon_AUC_baseline'] = 0.5
        out['stop_soon_positives_in_test'] = int(Y_stop[test].sum())
        prob = clf.predict_proba(Xte)[:, 1]
        sn = np.array([r.get('_stop_sign_seen', False) for r in ordered])[test]
        if sn.any():
            out['model_slowdown_prob_sign_seen'] = round(float(prob[sn].mean()), 2)
            out['model_slowdown_prob_no_sign'] = round(float(prob[~sn].mean()), 2)
    clf = HistGradientBoostingClassifier(**GB, class_weight='balanced').fit(Xtr, Y_turn[train])
    out['turn_balanced_acc'] = round(balanced_accuracy_score(Y_turn[test], clf.predict(Xte)), 3)
    out['turn_balanced_acc_baseline'] = round(1 / 3, 3)
    out['turn_frames_in_test'] = int((Y_turn[test] != 1).sum())
    # With ~100 turn frames the learned model can't pick up the directions on
    # its own yet, so follow them directly when a turn is under 30 m away.
    turn_all = follow_directions(clf.predict_proba(Xall))
    out['turn_balanced_acc_following_directions'] = round(balanced_accuracy_score(Y_turn[test], turn_all[test].argmax(1)), 3)
    seen = np.array([r.get('_stop_sign_seen', False) for r in ordered])[test]
    if Y_stop[test].sum():
        out['slowdown_rate_when_stop_sign_seen'] = round(float(Y_stop[test][seen].mean()), 2) if seen.any() else None
        out['slowdown_rate_otherwise'] = round(float(Y_stop[test][~seen].mean()), 2)
    preds = {'speed': np.clip(reg.predict(Xall), 0, None).round(2).tolist(),
             'slow': clf_stop.predict_proba(Xall)[:, 1].round(3).tolist(),
             'turn': turn_all.round(3).tolist(), 'test': test.tolist()}
    PRED[name] = preds
    print(json.dumps(out))
    return out

PRED = {}
ids = sorted(by)
rng = np.random.default_rng(0)
hold = set(rng.choice(ids, size=7, replace=False))
results = [run('held-out recordings (7 of 34)', np.isin(rec, list(hold)))]
cut = np.quantile(lng, 0.75)  # easternmost quarter of the riding area
results.append(run(f'held-out area (east of {cut:.4f})', lng > cut))
json.dump(results, open('results.json', 'w'), indent=1)

json.dump({'frames': [r['frame'] for r in ordered], 'rec': rec.tolist(), 'speed': Y_speed.round(2).tolist(),
           'slow': Y_stop.tolist(), 'turn': Y_turn.tolist(), 'sign': [bool(r.get('_stop_sign_seen')) for r in ordered],
           'lat': lat, 'lng': lng.tolist(), 'splits': PRED}, open('preds.json', 'w'))
print('saved preds.json')
