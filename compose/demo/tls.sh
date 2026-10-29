#!/bin/sh
# Serves HTTPS on 8443 with a self-signed leaf certificate that is valid for 5 days.
set -eu
openssl req -x509 -newkey rsa:2048 -nodes -days 5 -subj "/CN=demo-tls" \
  -keyout /tmp/key.pem -out /tmp/cert.pem
exec openssl s_server -accept 8443 -cert /tmp/cert.pem -key /tmp/key.pem -www
