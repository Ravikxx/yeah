# Waymark Bench

A one-screen iPhone app that times the co-pilot's three models (the same .onnx files as the website) on the phone itself:
processor with 1, 4 and 6 threads, and Core ML (Neural Engine / GPU).

It is built by GitHub Actions (`.github/workflows/ios-bench.yml`) into an unsigned `WaymarkBench.ipa`, which you install
with Sideloadly or AltStore using a free Apple ID (the app then lasts 7 days).
