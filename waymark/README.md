# Waymark

Your own street view, plus maps and directions.

You're the street-view car. Tap **Drive & capture**, mount your phone facing forward, and ride your streets.
Video and GPS record nonstop and upload in 2-minute pieces. Ride each street once each way and you can
look in both directions there.

Live at <https://ravikxx.github.io/yeah/waymark/>.

## What you can do

- **Drive & capture:** continuous camera + GPS. Pieces are saved in the browser first (IndexedDB) and upload in
  the background, so a weak signal doesn't lose footage. While capturing, a banner tells you whether the
  street you're on is new, done one way, or done both ways.
- **Map:** captured streets are drawn green (both directions) or amber with arrows (one direction so far).
- **Street view:** tap a captured street. Step forward or back, **Turn around** (switches to the footage you
  shot going the other way), turn onto crossing streets you've captured, or press **Drive** to roll through the
  footage. Keyboard: arrows, `U` to turn around, space to drive.
- **Directions:** tap the map, choose Directions. Routes come from an OpenStreetMap router (the only outside
  service the app calls). You see how much of the trip has your street view, can **Preview** the whole trip
  through your footage, or **Start** live navigation, which shows the matching view as you go.
- **Routes:** point-to-point walkthroughs with turn signs and notes ("use the blue door").

## How it fits together

- **This folder** is a static site on GitHub Pages: plain ES modules, Leaflet for maps, no build step.
- **Backend** is the `waymark-api` Cloudflare Worker (`waymark-worker/` on the `waymark-backend` branch of
  `SennoricAI/Sennoric`) with D1 for tracks and R2 for video. Pushing that branch deploys it.
- `js/street.js` is the street-view core: it indexes every recording's GPS track and, for a spot and a facing
  direction, finds the recording that passed there going that way and the exact second of video.

## Limits

- Capture uses about 11 MB of data per minute. A network can upload up to 4 GB a day.
- Footage is public by default; choose **Only me** before capturing to keep it to your browser.

## Tests

```sh
cd waymark && npm test   # turn detection, route snapping, street view matching, two-way coverage
```
