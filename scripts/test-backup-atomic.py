"""Run backup.sh with fake Docker and disposable data; never access a real stack."""

from datetime import datetime, timedelta
import fcntl
import gzip
import io
import os
from pathlib import Path
import random
import shutil
import stat
import subprocess
import tarfile
import tempfile


source = Path(__file__).resolve().parents[1] / "infra/backup/backup.sh"
docker_stub = """#!/usr/bin/env python3
import os, sys
from pathlib import Path
args = sys.argv[1:]
case = os.environ['BACKUP_TEST_CASE']
if args == ['info']:
    pass
elif args == ['volume', 'ls', '-q']:
    print('fixture_trosv-storage')
elif args[:4] == ['compose', '--profile', 'tls', 'exec']:
    for file in Path(os.environ['BACKUP_DIR']).glob('.incomplete-*/db-*'):
        assert file.stat().st_mode & 0o777 == 0o600
    sys.stdout.buffer.write(Path(os.environ['BACKUP_TEST_SQL']).read_bytes())
    if case == 'dump failure': sys.exit(1)
elif args[:2] == ['run', '--rm']:
    if case == 'uploads failure':
        sys.stdout.buffer.write(b'partial archive')
        sys.exit(1)
    if case == 'corrupt uploads': sys.stdout.buffer.write(b'not a tar archive')
    else: sys.stdout.buffer.write(Path(os.environ['BACKUP_TEST_TAR']).read_bytes())
else:
    raise SystemExit('Unexpected fake Docker invocation')
"""

cases = ["success", "verify alias", "dump failure", "small dump", "no tables",
         "corrupt dump", "uploads failure", "corrupt uploads", "config copy failure",
         "missing config", "empty config", "partial publish", "marker failure",
         "timestamp collision", "locked"]

for case in cases:
    with tempfile.TemporaryDirectory(prefix="trosv backup test ") as directory:
        root = Path(directory)
        repo = root / "repo"
        script = repo / "infra/backup/backup.sh"
        script.parent.mkdir(parents=True)
        script.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
        config = repo / ".env"
        if case != "missing config":
            config.write_text("" if case == "empty config" else "APP_KEY=test-fixture-only\n", encoding="utf-8")
        backup = root / "backup files"
        backup.mkdir()
        # Old, complete sets must survive every failed run, even with --verify.
        old = {}
        for i in range(12):
            day = datetime(2026, 10, 30) - timedelta(days=i)
            stamp = day.strftime("%Y%m%d-%H%M%S")
            for name in (f"db-{stamp}.sql.gz", f"uploads-{stamp}.tar.gz",
                         f"env-{stamp}.bak", f"complete-{stamp}"):
                path = backup / name
                path.write_bytes(b"old backup fixture")
                os.utime(path, (day.timestamp(), day.timestamp()))
                old[name] = path.read_bytes()
        timestamp = "20261115-023000"
        if case == "timestamp collision":
            path = backup / f"db-{timestamp}.sql.gz"
            path.write_bytes(b"existing unconfirmed file")
            old[path.name] = path.read_bytes()
        if case == "marker failure":
            (backup / f"complete-{timestamp}").symlink_to(root / "missing/marker")
        sql = root / "dump.sql"
        text = "CREATE TABLE fixture (id integer);\n-- " + random.Random(0).randbytes(4096).hex() + "\n"
        if case == "small dump": text = "CREATE TABLE fixture (id integer);\n"
        if case == "no tables": text = text.replace("CREATE TABLE", "fixture table")
        sql.write_text(text, encoding="utf-8")
        archive = root / "uploads.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            item = tarfile.TarInfo("fixture.txt")
            item.size = 7
            tar.addfile(item, io.BytesIO(b"fixture"))
        binaries = root / "bin"
        binaries.mkdir()

        def executable(name, code):
            path = binaries / name
            path.write_text(code, encoding="utf-8")
            path.chmod(0o755)

        executable("docker", docker_stub)
        real_date = shutil.which("date")
        executable("date", f"""#!/usr/bin/env python3
import os, sys
if sys.argv[1:] == ['+%Y%m%d-%H%M%S']: print('{timestamp}')
else: os.execv({real_date!r}, ['date', *sys.argv[1:]])
""")
        if case == "corrupt dump":
            executable("gzip", "#!/usr/bin/env python3\nimport sys\nsys.stdin.buffer.read()\nsys.stdout.buffer.write(b'x' * 2048)\n")
        if case == "config copy failure":
            executable("cp", "#!/bin/sh\nexit 1\n")
        if case == "partial publish":
            executable("mv", "#!/usr/bin/env python3\nimport shutil, sys\nshutil.move(sys.argv[2], sys.argv[-1])\nsys.exit(1)\n")
        lock = (backup / ".backup.lock").open("w")
        try:
            if case == "locked": fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run(
                ["bash", str(script), *(["--verify"] if case == "verify alias" else [])],
                env={**os.environ, "PATH": f"{binaries}:{os.environ['PATH']}",
                     "BACKUP_DIR": str(backup), "BACKUP_TEST_CASE": case,
                     "BACKUP_TEST_SQL": str(sql), "BACKUP_TEST_TAR": str(archive)},
                capture_output=True, text=True, timeout=15, umask=0o022,
            )
        finally:
            lock.close()
        marker = backup / f"complete-{timestamp}"
        if case in ("success", "verify alias"):
            assert result.returncode == 0, (case, result.stderr)
            assert marker.is_file(), case
            assert "CREATE TABLE" in gzip.decompress((backup / f"db-{timestamp}.sql.gz").read_bytes()).decode()
            with tarfile.open(backup / f"uploads-{timestamp}.tar.gz") as tar:
                assert tar.getnames() == ["fixture.txt"]
            assert (backup / f"env-{timestamp}.bak").read_bytes() == config.read_bytes()
            assert any(not (backup / name).exists() for name in old), "Retention did not run"
            for name in (f"db-{timestamp}.sql.gz", f"uploads-{timestamp}.tar.gz", f"env-{timestamp}.bak", marker.name):
                assert stat.S_IMODE((backup / name).stat().st_mode) == 0o600, name
        else:
            assert result.returncode != 0, (case, "Failure was swallowed")
            assert not marker.is_file(), (case, "Incomplete backup was confirmed")
            for name, content in old.items():
                assert (backup / name).read_bytes() == content, (case, "Old backup changed", name)
        assert not list(backup.glob(".incomplete-*")), (case, "Staging was not cleaned up")
        assert stat.S_IMODE(backup.stat().st_mode) == 0o700, case
        print(f"PASS: {case}")
