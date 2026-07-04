# Hand Ripple Camera

A lightweight open-source browser prototype that turns webcam finger motion into transparent ripple effects.

## Rebuild base

The new PixiJS-first baseline lives in `rebuild.html` and `rebuild.js`. It keeps the fingertip tracking flow but separates the renderer so we can keep iterating from a cleaner starting point.

## What it does

- Opens the camera in a full-screen scene.
- Tracks one hand and uses up to five fingertips.
- Draws water-like transparent ripples where fingers move.
- Works on desktop and mobile browsers.

## Run locally

1. Make sure `python` is installed.
2. From this folder, run:

```bash
python server.py
```

3. Open `http://localhost:8000` on your computer.
4. To use your phone, open the same IP address from the phone on the same Wi-Fi network, for example `http://192.168.1.20:8000`.
5. To try the new PixiJS baseline, open `http://localhost:8000/rebuild.html`.

## Open on phone

The camera only works on a secure page, so the easiest route is GitHub Pages.

1. Put these files into a GitHub repository.
2. Turn on GitHub Pages for the repository root.
3. Open the published `https://` link on your phone.
4. If prompted, allow camera access.

## Phone-friendly use

- The local server now prints a LAN URL, so you can open the same page from your phone on Wi-Fi.
- On phones, the controls stay in a compact bottom sheet so the camera view stays visible.
- For the camera to work on the phone browser, publish the app to HTTPS, for example with GitHub Pages.

## Notes

- Camera access requires a secure context on most phones. `localhost` is allowed on desktop, but a phone usually needs HTTPS or a tunneling service.
- The hand tracking runs entirely in the browser using MediaPipe from a CDN.
- This is a starter prototype, not a packaged app yet.
