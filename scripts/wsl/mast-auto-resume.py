#!/usr/bin/env python3
# mast 자동 재실행 대기열. 새 루트 셸이 에이전트 명령을 실행하기 직전에 `wait` 를 부른다.
#
# 종료 코드 계약 — 셸이 이 값으로 분기한다:
#   0    허가. 아무것도 출력하지 않는다. 셸이 이어서 명령을 실행한다.
#   1    건너뜀. 사유를 한 줄 쓴다. 셸은 수동 hint 로 남긴다.
#   130  Ctrl+C 로 취소.
# 이 파일은 어떤 명령도 실행하지 않는다. display-command 는 안내 문구에만 쓴다.
#
# 탭이 함께 깨어나도 한 번에 하나씩 나가도록 ~/.mast/auto-resume.lock 을 flock 으로 잡는다.
# 잠금 파일은 지우거나 교체하지 않는다. 대기자 모두가 같은 inode 를 잡아야 직렬화된다.
# 잠금은 허가를 내는 구간에만 쥐므로, 에이전트가 도는 동안에는 다른 탭을 막지 않는다.
#
# 직전 허가 시각은 time.monotonic() 값으로 잠금 파일에 적는다. Linux 와 macOS 의 monotonic 은
# 프로세스 사이에서 같은 시계다. 재부팅하면 리셋되므로, 현재보다 미래이거나 읽을 수 없는 값은
# "직전 허가 없음"으로 본다.
#
# SIGHUP 은 따로 잡지 않는다. 탭이 닫힌 뒤에는 허가를 내면 안 되므로 기본 동작으로 즉시 끝난다.
#
# Python 3.8 이상, 표준 라이브러리만 쓴다. POSIX 전용이다(fcntl, pread).

import fcntl
import math
import os
import sys
import time

MIN_INTERVAL = 3.0
TIMEOUT = 120.0
LOAD_RECHECK = 1.0
LOCK_POLL = 0.1
USAGE = "invalid arguments; expected: wait <display-command>"


class Skip(Exception):
    """건너뜀(exit 1)으로 끝낸다. 메시지가 사유다."""


class Admission:
    """허가 전까지의 모든 대기를 한곳에서 거친다. 상한을 넘기면 강행하지 않고 Skip 을 던진다."""

    def __init__(self, display, deadline):
        self.display = display
        self.deadline = deadline
        self.queued = False

    def pause(self, seconds):
        if time.monotonic() + seconds > self.deadline:
            raise Skip("timed out")
        if not self.queued:
            self.queued = True
            say("queued: %s (Ctrl+C to cancel)" % self.display)
        time.sleep(seconds)


def say(message):
    print("\033[2m[mast] auto-resume %s\033[0m" % message, file=sys.stderr, flush=True)


def skipped(reason):
    say("skipped: %s" % reason)
    return 1


def lock_path():
    return os.path.join(os.path.expanduser("~"), ".mast", "auto-resume.lock")


def run(display):
    admission = Admission(display, time.monotonic() + TIMEOUT)
    path = lock_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        acquire(fd, admission)
        wait_for_interval(fd, admission)
        wait_for_load(admission)
        record_permit(fd, time.monotonic())
    finally:
        os.close(fd)
    return 0


def acquire(fd, admission):
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            admission.pause(LOCK_POLL)


def wait_for_interval(fd, admission):
    last = read_last_permit(fd)
    while last is not None:
        gap = MIN_INTERVAL - (time.monotonic() - last)
        if gap <= 0:
            return
        admission.pause(gap)


def read_last_permit(fd):
    try:
        last = float(os.pread(fd, 64, 0).decode("ascii"))
    except ValueError:
        return None
    if not math.isfinite(last) or last > time.monotonic():
        return None
    return last


def wait_for_load(admission):
    while is_busy():
        admission.pause(LOAD_RECHECK)


def is_busy():
    try:
        load = os.getloadavg()[0]
    except OSError:
        raise Skip("load average unavailable")
    cpus = os.cpu_count()
    if not cpus:
        raise Skip("CPU count unavailable")
    return load >= cpus


def record_permit(fd, now):
    os.ftruncate(fd, 0)
    os.pwrite(fd, repr(now).encode("ascii"), 0)


def main(argv):
    if len(argv) != 3 or argv[1] != "wait":
        return skipped(USAGE)
    try:
        return run(argv[2])
    except Skip as skip:
        return skipped(str(skip))
    except OSError as error:
        return skipped("queue state unavailable: %s" % error)
    except KeyboardInterrupt:
        say("cancelled")
        return 130


if __name__ == "__main__":
    sys.exit(main(sys.argv))
