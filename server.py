from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from functools import partial


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        return


def main():
    root = Path(__file__).resolve().parent
    handler = partial(QuietHandler, directory=str(root))
    server = ThreadingHTTPServer(("0.0.0.0", 8000), handler)
    print(f"Serving {root} at http://0.0.0.0:8000")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
