#!/usr/bin/env python3
"""Credential-free transport probe; never authenticates or executes SQL."""
import argparse
import hashlib
import json
import socket
import ssl
import struct
from pathlib import Path

ADDRESS = ("172.30.6.1", 15433)
HOSTNAME = "noodzakelijkonline-01"
CA = Path("/run/va-postgres-root.crt")


def tls_context(cafile=None):
    context = ssl.create_default_context(cafile=cafile)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    return context


def handshake(context, hostname):
    with socket.create_connection(ADDRESS, timeout=4) as connection:
        connection.sendall(struct.pack("!II", 8, 80877103))
        if connection.recv(1) != b"S":
            raise RuntimeError("PostgreSQL did not accept its SSLRequest")
        with context.wrap_socket(connection, server_hostname=hostname) as secured:
            if secured.version() not in ("TLSv1.2", "TLSv1.3"):
                raise RuntimeError("Unexpected TLS protocol")
            return secured.getpeercert(binary_form=True)


def run(expect_denied=False):
    if expect_denied:
        try:
            connection = socket.create_connection(ADDRESS, timeout=4)
        except OSError:
            return {"tcpDenied": True, "applicationAcceptance": False}
        connection.close()
        raise RuntimeError("Another network could reach the private database proxy")

    certificate = ssl.PEM_cert_to_DER_cert(CA.read_text(encoding="ascii"))
    peer = handshake(tls_context(cafile=str(CA)), HOSTNAME)
    if hashlib.sha256(peer).digest() != hashlib.sha256(certificate).digest():
        raise RuntimeError("The public certificate pin did not match")
    for context, hostname in (
        (tls_context(cafile=str(CA)), "wrong-va-host.invalid"),
        (tls_context(), HOSTNAME),
    ):
        try:
            handshake(context, hostname)
        except ssl.SSLCertVerificationError:
            continue
        raise RuntimeError("Invalid hostname or untrusted certificate was accepted")
    return {"tlsVerified": True, "wrongHostnameRejected": True,
            "untrustedCertificateRejected": True, "applicationAcceptance": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expect-denied", action="store_true")
    arguments = parser.parse_args()
    try:
        print(json.dumps(run(arguments.expect_denied), sort_keys=True))
    except (OSError, RuntimeError, ValueError):
        raise SystemExit("VA private transport probe failed; no credentials used")
