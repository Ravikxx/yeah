# Stop signs and traffic lights in every frame, from a COCO-pretrained detector.
import csv, json, torch, torchvision
from PIL import Image
rows = list(csv.DictReader(open('data/frames.csv')))
w = torchvision.models.detection.FasterRCNN_MobileNet_V3_Large_FPN_Weights.COCO_V1
net = torchvision.models.detection.fasterrcnn_mobilenet_v3_large_fpn(weights=w, box_score_thresh=0.3, min_size=512, max_size=900).eval()
cats = w.meta['categories']
want = {cats.index('stop sign'): 'stop_sign', cats.index('traffic light'): 'traffic_light'}
torch.set_num_threads(4)
tf = torchvision.transforms.functional
out = []
with torch.no_grad():
    for i in range(0, len(rows), 16):
        ims = [tf.to_tensor(Image.open('data/' + r['frame']).convert('RGB')) for r in rows[i:i + 16]]
        for r, d in zip(rows[i:i + 16], net(ims)):
            dets = [{'cls': want[int(l)], 'score': round(float(s), 3), 'box': [round(float(v)) for v in b]}
                    for b, l, s in zip(d['boxes'], d['labels'], d['scores']) if int(l) in want]
            out.append({'frame': r['frame'], 'dets': dets})
        if i % 320 == 0: print(i, flush=True)
json.dump(out, open('dets.json', 'w'))
print('frames with stop sign >=0.5:', sum(any(d['cls'] == 'stop_sign' and d['score'] >= .5 for d in o['dets']) for o in out),
      '| traffic light >=0.5:', sum(any(d['cls'] == 'traffic_light' and d['score'] >= .5 for d in o['dets']) for o in out))
