#!/bin/sh
set -eu
# The seed contains Chinese text. Set the client charset as well as the server's.
MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --default-character-set=utf8mb4 \
  --protocol=socket -uroot "$MYSQL_DATABASE" < /bootstrap/system.sql
