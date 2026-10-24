# Waymark

Record a trip with your phone's camera and GPS, and Waymark turns it into a route other people can follow:
the video plays with every turn called out on a road-sign overlay, and **Follow live** jumps the video to
the matching spot as you walk it yourself.

Live at <https://ravikxx.github.io/yeah/waymark/>.

## How it fits together

- **This folder** is a static site served by GitHub Pages (no build step, plain ES modules, Leaflet for maps).
- **Backend** is the `waymark-api` Cloudflare Worker (`waymark-worker/` on the `waymark-backend` branch of
  `SennoricAI/Sennoric`), with a D1 database for route data and an R2 bucket for videos and thumbnails.
  Pushing that branch deploys it.
- Turns are detected in the browser from the GPS track (`js/geo.js`). Directions to a route's start come from
  the OpenStreetMap-based routers at routing.openstreetmap.de, proxied through the Worker.

## Limits

- Up to 10 minutes or 90 MB per recording. 20 uploads per network per day.
- Anyone can upload. Uploaders can delete their own routes from the browser they uploaded with.

## Tests

```sh
cd waymark && npm test   # turn detection, route snapping, units
```
