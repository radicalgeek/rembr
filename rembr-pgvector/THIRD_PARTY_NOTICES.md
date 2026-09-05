# Third-party notices: Rembr self-host database image

The self-host database image derives from
`pgvector/pgvector:pg16@sha256:a36250871de0833b8757561c72f2477ef1ddd1101afa4e617fb552e0de514c6b`.
The pinned base contains PostgreSQL 16 and pgvector 0.8.6. Rembr removes the
dormant `gosu` privilege helper and adds the public self-host schema and
versioned database bootstrap files.

pgvector is distributed under the PostgreSQL Licence. The upstream licence is
preserved in the image at `/usr/share/doc/pgvector/LICENSE` and is available
from <https://github.com/pgvector/pgvector/blob/v0.8.6/LICENSE>.

The PostgreSQL and Debian package copyright and licence notices from the exact
base remain available below `/usr/share/doc/`. The removed `gosu` binary is not
redistributed by this derivative.
