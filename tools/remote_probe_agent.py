#!/usr/bin/env python3
import json
import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import quote


LISTEN_HOST = os.environ.get("PROBE_AGENT_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("PROBE_AGENT_PORT", "8787"))
BEARER_TOKEN = os.environ.get("PROBE_AGENT_TOKEN", "").strip()
DEFAULT_TIMEOUT_MS = int(os.environ.get("PROBE_AGENT_TIMEOUT_MS", "6000"))
MAX_WORKERS = int(os.environ.get("PROBE_AGENT_MAX_WORKERS", "32"))
SING_BOX_BIN = os.environ.get("PROBE_AGENT_SING_BOX_BIN", "").strip()
REALITY_TEST_HOST = os.environ.get("PROBE_AGENT_REALITY_TEST_HOST", "").strip()


def resolve_sing_box_binary() -> str | None:
    if SING_BOX_BIN:
        return SING_BOX_BIN if os.path.exists(SING_BOX_BIN) else None

    return shutil.which("sing-box")


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


def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_port(port: int, timeout_ms: int) -> bool:
    deadline = time.monotonic() + (timeout_ms / 1000)

    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), 0.25):
                return True
        except Exception:
            time.sleep(0.05)

    return False


def build_sing_box_outbound(target: dict[str, Any]) -> dict[str, Any]:
    outbound: dict[str, Any] = {
        "type": "vless",
        "tag": "proxy",
        "server": str(target.get("address") or "").strip(),
        "server_port": int(target.get("port")),
        "uuid": str(target.get("credential") or "").strip(),
    }

    flow = str(target.get("flow") or "").strip()
    if flow == "xtls-rprx-vision":
        outbound["flow"] = flow

    tls_config: dict[str, Any] = {
        "enabled": True,
        "server_name": str(
            target.get("sni") or target.get("host") or target.get("authority") or ""
        ).strip(),
        "reality": {
            "enabled": True,
            "public_key": str(target.get("publicKey") or "").strip(),
        },
        "utls": {
            "enabled": True,
            "fingerprint": str(target.get("fingerprint") or "").strip() or "chrome",
        },
    }

    short_id = str(target.get("shortId") or "").strip()
    if short_id:
        tls_config["reality"]["short_id"] = short_id

    alpn = str(target.get("alpn") or "").strip()
    if alpn:
        tls_config["alpn"] = [part.strip() for part in alpn.split(",") if part.strip()]

    outbound["tls"] = tls_config

    network = str(target.get("network") or "tcp").lower()
    host = str(target.get("host") or "").strip()
    path = str(target.get("path") or "").strip()

    if network == "ws":
        transport: dict[str, Any] = {"type": "ws"}
        if path:
            transport["path"] = path if path.startswith("/") else f"/{path}"
        if host:
            transport["headers"] = {"Host": host}
        outbound["transport"] = transport
    elif network == "httpupgrade":
        transport = {"type": "httpupgrade"}
        if host:
            transport["host"] = host
        if path:
            transport["path"] = path if path.startswith("/") else f"/{path}"
        outbound["transport"] = transport

    return outbound


def probe_https_via_http_proxy(proxy_port: int, host: str, timeout_ms: int) -> int | None:
    started = time.monotonic()

    try:
        with socket.create_connection(("127.0.0.1", proxy_port), timeout_ms / 1000) as raw_sock:
            raw_sock.settimeout(timeout_ms / 1000)
            connect_request = (
                f"CONNECT {host}:443 HTTP/1.1\r\n"
                f"Host: {host}:443\r\n"
                "Proxy-Connection: close\r\n\r\n"
            )
            raw_sock.sendall(connect_request.encode("utf-8"))

            response = b""
            while b"\r\n\r\n" not in response:
                chunk = raw_sock.recv(4096)
                if not chunk:
                    return None
                response += chunk

            status_line = response.split(b"\r\n", 1)[0].decode("utf-8", "ignore")
            if " 200 " not in status_line:
                return None

            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE

            with context.wrap_socket(raw_sock, server_hostname=host) as tls_sock:
                request = (
                    "HEAD / HTTP/1.1\r\n"
                    f"Host: {host}\r\n"
                    "Connection: close\r\n"
                    "User-Agent: remnawave-remote-probe\r\n\r\n"
                )
                tls_sock.sendall(request.encode("utf-8"))
                tls_sock.recv(1)
                return round((time.monotonic() - started) * 1000)
    except Exception:
        return None


def probe_reality(target: dict[str, Any], timeout_ms: int) -> int | None:
    sing_box_bin = resolve_sing_box_binary()
    if not sing_box_bin:
        return None

    credential = str(target.get("credential") or "").strip()
    public_key = str(target.get("publicKey") or "").strip()
    if not credential or not public_key:
        return None

    probe_host = (
        str(target.get("sni") or "").strip()
        or str(target.get("host") or "").strip()
        or str(target.get("authority") or "").strip()
        or REALITY_TEST_HOST
    )
    if not probe_host:
        return None

    proxy_port = get_free_port()
    config = {
        "log": {"disabled": True},
        "inbounds": [
            {
                "type": "http",
                "tag": "probe-http",
                "listen": "127.0.0.1",
                "listen_port": proxy_port,
            }
        ],
        "outbounds": [
            build_sing_box_outbound(target),
            {"type": "direct", "tag": "direct"},
        ],
        "route": {
            "auto_detect_interface": True,
            "rules": [{"inbound": ["probe-http"], "outbound": "proxy"}],
        },
    }

    with tempfile.TemporaryDirectory(prefix="rw-reality-probe-") as temp_dir:
        config_path = os.path.join(temp_dir, "config.json")
        with open(config_path, "w", encoding="utf-8") as handle:
            json.dump(config, handle)

        process = subprocess.Popen(
            [sing_box_bin, "run", "-D", temp_dir, "-c", config_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            if not wait_for_port(proxy_port, min(timeout_ms, 3000)):
                return None

            return probe_https_via_http_proxy(proxy_port, probe_host, timeout_ms)
        finally:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)


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
    elif security == "reality":
        transport_latency = probe_reality(target, timeout_ms)
        result["transportProbe"] = "REALITY" if transport_latency is not None else "NONE"

    result["transportLatencyMs"] = transport_latency

    successful = [lat for lat in (tcp_latency, transport_latency) if isinstance(lat, int)]
    if successful:
        result["latencyMs"] = min(successful)

    return result


class Handler(BaseHTTPRequestHandler):
    server_version = "remnawave-remote-probe/1.0"

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json(
                200,
                {
                    "status": "ok",
                    "realityProbe": {
                        "enabled": bool(resolve_sing_box_binary()),
                    },
                },
            )
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

        normalized_targets = [target for target in targets if isinstance(target, dict)]
        with ThreadPoolExecutor(max_workers=max(1, min(MAX_WORKERS, len(normalized_targets) or 1))) as executor:
            results = list(executor.map(lambda target: probe_target(target, timeout_ms), normalized_targets))
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
