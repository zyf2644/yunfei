from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from functools import partial
import socket


def get_lan_ip():
    try:
      with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        return


def main():
    root = Path(__file__).resolve().parent
    handler = partial(QuietHandler, directory=str(root))
    server = ThreadingHTTPServer(("0.0.0.0", 8000), handler)
    lan_ip = get_lan_ip()
    print(f"Serving {root} at http://0.0.0.0:8000")
    print(f"Phone-friendly LAN URL: http://{lan_ip}:8000")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
