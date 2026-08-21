"""Permite `python -m beatsync.server` para subir o Studio."""

from __future__ import annotations

import os


def main() -> None:
    try:
        import uvicorn
    except ImportError as exc:  # pragma: no cover
        raise SystemExit(
            "uvicorn é necessário para rodar o Studio. "
            "Instale com: pip install 'fastapi[standard]' uvicorn"
        ) from exc

    host = os.environ.get("BEATSYNC_HOST", "127.0.0.1")
    port = int(os.environ.get("BEATSYNC_PORT", "8000"))
    print(f"\n  ✦ beatsync Studio em  http://{host}:{port}\n")
    uvicorn.run("beatsync.server.app:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
