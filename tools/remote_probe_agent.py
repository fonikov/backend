#!/usr/bin/env python3
import json
import os
import socket
import ssl
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import quote


LISTEN_HOST = os.environ.get("PROBE_AGENT_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("PROBE_AGENT_PORT", "8787"))
BEARER_TOKEN = os.environ.get("PROBE_AGENT_TOKEN", "").strip()
DEFAULT_TIMEOUT_MS = int(os.environ.get("PROBE_AGENT_TIMEOUT_MS", "6000"))


def resolve_address(address: str) -> str | None:
    try:
        if _is_ip(address):
            return address

        infos = socket.getaddrinfo(address, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        for family, _, _, _, sockaddr in infos:
            if family in (socket.AF_INET, socket.AF_INET6):
                return sockaddr[0]
    except Exception:
        return None
    return None


def _is_ip(address: str) -> bool:
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            socket.inet_pton(family, address)
            return True
        except OSError:
            continue
    return False


def probe_tcp(address: str, port: int, timeout_ms: int) -> int | None:
    started = time.monotonic()
    try:
        with socket.create_connection((address, port), timeout_ms / 1000):
            return round((time.monotonic() - started) * 1000)
    except Exception:
        return None


def probe_tls(
    address: str,
    port: int,
    timeout_ms: int,
    servername: str | None,
) -> int | None:
    started = time.monotonic()
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE

    try:
        with socket.create_connection((address, port), timeout_ms / 1000) as raw_sock:
            raw_sock.settimeout(timeout_ms / 1000)
            with context.wrap_socket(raw_sock, server_hostname=servername) as tls_sock:
                tls_sock.do_handshake()
                return round((time.monotonic() - started) * 1000)
    except Exception:
        return None


def probe_https(
    address: str,
    port: int,
    timeout_ms: int,
    servername: str | None,
    host_header: str | None,
    path: str | None,
) -> int | None:
    started = time.monotonic()
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE

    normalized_path = path or "/"
    if not normalized_path.startswith("/"):
        normalized_path = "/" + normalized_path

    encoded_path = quote(
        normalized_path,
        safe="/:?&=%#+,;@[]!$&'()*~-._",
    )

    try:
        with socket.create_connection((address, port), timeout_ms / 1000) as raw_sock:
            raw_sock.settimeout(timeout_ms / 1000)
            with context.wrap_socket(raw_sock, server_hostname=servername) as tls_sock:
                request = (
                    f"HEAD {encoded_path} HTTP/1.1\r\n"
                    f"Host: {host_header or servername or address}\r\n"
                    "Connection: close\r\n"
                    "User-Agent: remnawave-remote-probe\r\n\r\n"
                )
                tls_sock.sendall(request.encode("utf-8"))
                tls_sock.recv(1)
                return round((time.monotonic() - started) * 1000)
    except Exception:
        return None


def probe_target(target: dict[str, Any], timeout_ms: int) -> dict[str, Any]:
    address = str(target.get("address") or "").strip()
    port = target.get("port")

    result = {
        "id": target.get("id"),
        "resolvedAddress": None,
        "latencyMs": None,
        "tcpLatencyMs": None,
        "transportLatencyMs": None,
        "transportProbe": "NONE",
    }

    if not address or not isinstance(port, int) or port <= 0 or port > 65535:
        return result

    resolved_address = resolve_address(address)
    result["resolvedAddress"] = resolved_address

    if not resolved_address:
        return result

    security = str(target.get("security") or "none").lower()
    network = str(target.get("network") or "tcp").lower()
    sni = target.get("sni") or None
    host = target.get("host") or None
    authority = target.get("authority") or None
    servername = sni or host or authority

    tcp_latency = probe_tcp(resolved_address, port, timeout_ms)
    result["tcpLatencyMs"] = tcp_latency

    transport_latency = None
    if security == "tls" and network in ("httpupgrade", "ws", "xhttp"):
        result["transportProbe"] = "HTTPS"
        transport_latency = probe_https(
            resolved_address,
            port,
            timeout_ms,
            servername,
            host or authority or servername,
            target.get("path"),
        )
    elif security == "tls":
        result["transportProbe"] = "TLS"
        transport_latency = probe_tls(resolved_address, port, timeout_ms, servername)

    result["transportLatencyMs"] = transport_latency

    successful = [lat for lat in (tcp_latency, transport_latency) if isinstance(lat, int)]
    if successful:
        result["latencyMs"] = min(successful)

    return result


class Handler(BaseHTTPRequestHandler):
    server_version = "remnawave-remote-probe/1.0"

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json(200, {"status": "ok"})
            return
        self._send_json(404, {"message": "Not Found"})

    def do_POST(self) -> None:
        if self.path != "/probe":
            self._send_json(404, {"message": "Not Found"})
            return

        if BEARER_TOKEN:
            auth = self.headers.get("Authorization", "")
            if auth != f"Bearer {BEARER_TOKEN}":
                self._send_json(401, {"message": "Unauthorized"})
                return

        length = int(self.headers.get("Content-Length", "0"))
        try:
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8") if raw else "{}")
        except Exception:
            self._send_json(400, {"message": "Invalid JSON"})
            return

        targets = payload.get("targets")
        if not isinstance(targets, list):
            self._send_json(400, {"message": "targets must be an array"})
            return

        requested_timeout = payload.get("timeoutMs")
        timeout_ms = (
            requested_timeout
            if isinstance(requested_timeout, int) and 1000 <= requested_timeout <= 60000
            else DEFAULT_TIMEOUT_MS
        )

        results = [probe_target(target, timeout_ms) for target in targets if isinstance(target, dict)]
        self._send_json(200, {"results": results})

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    print(f"remote probe agent listening on {LISTEN_HOST}:{LISTEN_PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
