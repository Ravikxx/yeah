# Image features for every frame from a pretrained ResNet-18 (CPU).
import csv, numpy as np, torch, torchvision
from PIL import Image
rows = list(csv.DictReader(open('data/frames.csv')))
w = torchvision.models.ResNet18_Weights.IMAGENET1K_V1
net = torchvision.models.resnet18(weights=w); net.fc = torch.nn.Identity(); net.eval()
tf = w.transforms()
torch.set_num_threads(4)
feats = []
with torch.no_grad():
    for i in range(0, len(rows), 64):
        batch = []
        for r in rows[i:i + 64]:
            im = Image.open('data/' + r['frame']).convert('RGB')
            W, H = im.size
            im = im.crop((0, 0, W, int(H * 0.78)))  # drop the handlebars at the bottom
            batch.append(tf(im))
        feats.append(net(torch.stack(batch)).numpy())
        print(i, end=' ', flush=True)
np.save('feats.npy', np.concatenate(feats).astype(np.float32))
print('\ndone', len(rows))
