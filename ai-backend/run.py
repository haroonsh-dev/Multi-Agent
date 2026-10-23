"""Start script — frees THIS app's port listeners, then launches the server."""
import os
import sys
import time
import subprocess
import logging
import warnings
warnings.filterwarnings("ignore", category=DeprecationWarning, module="langchain")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("run")

HOST = "0.0.0.0"
# Default 8001 — avoids clash with other local apps on 8000 (e.g. PHP/Laravel)
PORT = int(os.getenv("AI_BACKEND_PORT", "8001"))


def free_port(port: int):
    """Kill every process listening on the given port (IPv4/IPv6, all bind addresses)."""
    import sys
    try:
        if sys.platform == "win32":
            # Windows
            result = subprocess.run(
                ["netstat", "-ano"], capture_output=True, text=True,
                creationflags=subprocess.CREATE_NO_WINDOW
            )
            pids = set()
            needle = f":{port}"
            for line in result.stdout.splitlines():
                parts = line.strip().split()
                if len(parts) < 5 or "LISTENING" not in parts:
                    continue
                local = parts[1]
                if local.endswith(needle) or local.endswith(f"]{needle}"):
                    pids.add(parts[-1])

            for pid in pids:
                if not pid.isdigit() or pid == "0":
                    continue
                subprocess.run(
                    ["taskkill", "/F", "/PID", pid],
                    capture_output=True,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
                logger.info(f"Killed PID {pid} (held port {port})")
            if pids:
                time.sleep(1.5)
        else:
            # macOS / Linux
            result = subprocess.run(["lsof", "-t", f"-i:{port}"], capture_output=True, text=True)
            pids = result.stdout.strip().split()
            for pid in pids:
                if pid:
                    subprocess.run(["kill", "-9", pid])
                    logger.info(f"Killed PID {pid} (held port {port})")
            if pids:
                time.sleep(1.5)
    except Exception as e:
        logger.warning(f"free_port error: {e}")


if __name__ == "__main__":
    free_port(PORT)
    logger.info(f"Starting Visibility Docs AI on {HOST}:{PORT}...")
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    from uvicorn.main import run
    run("app.main:app", host=HOST, port=PORT, log_level="info")
