#!/usr/bin/env python3
import subprocess
import sys
import time
from pathlib import Path


def main():
    mode = sys.argv[1]
    if mode == 'sleep':
        time.sleep(float(sys.argv[2]))
        return
    if mode == 'spawn-child':
        pid_path = Path(sys.argv[2])
        child = subprocess.Popen(
            [sys.executable, '-c', 'import time; time.sleep(60)'],
        )
        pid_path.write_text(str(child.pid), encoding='ascii')
        time.sleep(60)
        return
    raise SystemExit(f'unknown mode: {mode}')


if __name__ == '__main__':
    main()
