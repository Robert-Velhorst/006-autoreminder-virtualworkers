"""Offline contract tests; no sockets, credentials or SQL are used."""
import importlib.util
from pathlib import Path
import ssl
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location(
    "probe", Path(__file__).with_name("probe_postgres_tls.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def test_tls_pin_and_both_negative_checks_are_required(self):
        with patch.object(probe.CA.__class__, "read_text", return_value="pem"), \
             patch.object(probe.ssl, "PEM_cert_to_DER_cert", return_value=b"cert"), \
             patch.object(probe.ssl, "create_default_context"), \
             patch.object(probe, "handshake", side_effect=[
                 b"cert", ssl.SSLCertVerificationError(), ssl.SSLCertVerificationError()
             ]) as handshake:
            result = probe.run()
        self.assertTrue(result["tlsVerified"])
        self.assertFalse(result["applicationAcceptance"])
        self.assertEqual(handshake.call_count, 3)

    def test_pin_mismatch_fails(self):
        with patch.object(probe.CA.__class__, "read_text", return_value="pem"), \
             patch.object(probe.ssl, "PEM_cert_to_DER_cert", return_value=b"cert"), \
             patch.object(probe.ssl, "create_default_context"), \
             patch.object(probe, "handshake", return_value=b"other"):
            with self.assertRaises(RuntimeError):
                probe.run()

    def test_each_invalid_certificate_acceptance_fails(self):
        for responses in (
            [b"cert", b"accepted"],
            [b"cert", ssl.SSLCertVerificationError(), b"accepted"],
        ):
            with self.subTest(responses=len(responses)), \
                 patch.object(probe.CA.__class__, "read_text", return_value="pem"), \
                 patch.object(probe.ssl, "PEM_cert_to_DER_cert", return_value=b"cert"), \
                 patch.object(probe.ssl, "create_default_context"), \
                 patch.object(probe, "handshake", side_effect=responses):
                with self.assertRaises(RuntimeError):
                    probe.run()

    def test_denied_network_requires_connection_failure(self):
        with patch.object(probe.socket, "create_connection", side_effect=TimeoutError):
            self.assertTrue(probe.run(True)["tcpDenied"])
        connection = MagicMock()
        with patch.object(probe.socket, "create_connection", return_value=connection):
            with self.assertRaises(RuntimeError):
                probe.run(True)
        connection.close.assert_called_once()

    def test_ssl_request_refusal_fails_before_tls(self):
        connection = MagicMock()
        connection.__enter__.return_value = connection
        connection.recv.return_value = b"N"
        context = MagicMock()
        with patch.object(probe.socket, "create_connection", return_value=connection):
            with self.assertRaises(RuntimeError):
                probe.handshake(context, probe.HOSTNAME)
        context.wrap_socket.assert_not_called()
        connection.sendall.assert_called_once_with(probe.struct.pack("!II", 8, 80877103))


if __name__ == "__main__":
    unittest.main()
