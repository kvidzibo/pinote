"""Shared diagnostics, independent of either desktop frontend."""

from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler

from pinote.paths import Paths, private_directory, private_file

LOGGER = logging.getLogger("pinote")


def configure_logging(paths: Paths) -> None:
    # Repeated main() calls in tests or embedding must not duplicate handlers.
    for handler in LOGGER.handlers[:]:
        LOGGER.removeHandler(handler)
        handler.close()
    LOGGER.setLevel(logging.INFO)
    LOGGER.propagate = False
    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
    LOGGER.addHandler(stream)
    private_directory(paths.state)
    private_file(paths.log)
    file_handler = RotatingFileHandler(paths.log, maxBytes=1_000_000, backupCount=3)
    file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    LOGGER.addHandler(file_handler)
