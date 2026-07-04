# Hand Ripple Camera

A lightweight open-source browser prototype that turns webcam finger motion into transparent ripple effects.

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

## Open on phone

The camera only works on a secure page, so the easiest route is GitHub Pages.

1. Put these files into a GitHub repository.
2. Turn on GitHub Pages for the repository root.
3. Open the published `https://` link on your phone.
4. If prompted, allow camera access.

## Notes

- Camera access requires a secure context on most phones. `localhost` is allowed on desktop, but a phone may need HTTPS or a tunneling service.
- The hand tracking runs entirely in the browser using MediaPipe from a CDN.
- This is a starter prototype, not a packaged app yet.
