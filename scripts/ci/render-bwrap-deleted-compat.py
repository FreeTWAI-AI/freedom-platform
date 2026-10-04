#!/usr/bin/env python3
"""Render a reviewed flag-only candidate; never compile or load kernel policy."""
import hashlib
import os
import stat
import sys

STOCK_SHA256 = "11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9"


def render(source: bytes) -> bytes:
    if hashlib.sha256(source).hexdigest() != STOCK_SHA256:
        raise ValueError("stock_profile_mismatch")
    for declaration in (
        b"profile bwrap /usr/bin/bwrap flags=(attach_disconnected) {",
        b"profile unpriv_bwrap flags=(attach_disconnected) {",
    ):
        if source.count(declaration) != 1:
            raise ValueError("stock_profile_mismatch")
        source = source.replace(declaration, declaration.replace(
            b"attach_disconnected)", b"attach_disconnected,mediate_deleted)"), 1)
    return source


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("invalid_profile_input")
        fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 16384:
                raise ValueError("invalid_profile_input")
            result = render(source.read(16385))
        sys.stdout.buffer.write(result)
    except (OSError, ValueError):
        sys.stderr.write("bwrap_compat_profile_rejected\n")
        sys.exit(1)
