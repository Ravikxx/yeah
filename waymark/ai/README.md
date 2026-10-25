# Waymark driving model (first version)

Run from a folder containing `data/` made by `tools/waymark_export.py --fps 1`:

```sh
pip install torch torchvision scikit-learn --index-url https://download.pytorch.org/whl/cpu
python embed.py    # image features (ResNet-18)          -> feats.npy
python detect.py   # stop signs / traffic lights (COCO)   -> dets.json
python train.py    # trains + tests on held-out rides and a held-out area
```

Results on 34 rides (50 min) are in `results-2026-10-25.json`.
