#!/usr/bin/env python3
"""agent-hooks.test.ts 의 프로세스 제어기.

한 줄 JSON 요청을 받아 한 줄 JSON 으로 답한다. 이 프로세스가 세션 리더로서 pty 를 controlling
tty 로 잡고 그 세션 안에서 훅을 띄운다. 에이전트가 tty 를 쥐고 훅이 그 자식인 production 모양과
같다. 훅마다 새 세션을 만들면 살아 있는 sleeper 세션이 tty 를 쥔 동안 다음 훅의 TIOCSCTTY 가
EPERM 이 된다. 테스트가 프로세스 사이 순서를 barrier 로 잡을 수 있게 flock 보유, pty 버퍼 막기,
`/proc/<pid>/wchan` 조회를 제공한다.
"""

import fcntl
import json
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import threading
import time
import tty

# Codex 훅처럼 controlling tty 의 백그라운드 process group 에서 TOSTOP 이 켜진 채 쓰게 한다
# (codex-rs/hooks/src/engine/command_runner.rs:224-225 의 process_group(0)).
BACKGROUND_WRAPPER = r"""
import os, signal, subprocess, sys, termios
terminal = os.open("/dev/tty", os.O_RDWR)
attrs = termios.tcgetattr(terminal)
attrs[3] |= termios.TOSTOP
termios.tcsetattr(terminal, termios.TCSANOW, attrs)
os.close(terminal)
child = subprocess.Popen(sys.argv[1:], preexec_fn=os.setpgrp)
def stop(_signum, _frame):
    os.killpg(child.pid, signal.SIGKILL)
    sys.exit(124)
signal.signal(signal.SIGTERM, stop)
sys.exit(child.wait())
"""

# controlling tty 없이 조상(이 래퍼)의 fd 2 만 pts 인 경우. Claude Code 훅이 이 모양이다.
ANCESTOR_WRAPPER = r"""
import subprocess, sys
sys.exit(subprocess.call(sys.argv[1:], stderr=subprocess.DEVNULL))
"""

SYNC_PREFIX = b"\x1b]999;sync-"


class Proc(object):
    def __init__(self, popen, stdin_bytes):
        self.popen = popen
        self.started = time.monotonic()
        self.finished = None
        self.stdout = bytearray()
        self.stderr = bytearray()
        self.epipe = False
        self.threads = [
            threading.Thread(target=self._feed, args=(stdin_bytes,)),
            threading.Thread(target=self._drain, args=(popen.stdout, self.stdout)),
        ]
        if popen.stderr is not None:
            self.threads.append(threading.Thread(target=self._drain, args=(popen.stderr, self.stderr)))
        for thread in self.threads:
            thread.daemon = True
            thread.start()

    def _feed(self, data):
        try:
            self.popen.stdin.write(data)
            self.popen.stdin.close()
        except BrokenPipeError:
            self.epipe = True
        except OSError:
            self.epipe = True

    @staticmethod
    def _drain(stream, sink):
        while True:
            chunk = stream.read(65536)
            if not chunk:
                return
            sink.extend(chunk)


class Harness(object):
    def __init__(self):
        self.master, self.slave = pty.openpty()
        tty.setraw(self.slave)
        # 테스트가 node 에서 detached(setsid)로 띄우므로 이 프로세스는 tty 없는 세션 리더다.
        fcntl.ioctl(self.slave, termios.TIOCSCTTY, 0)
        self.slave_path = os.ttyname(self.slave)
        self.captured = bytearray()
        self.procs = {}
        self.next_id = 1
        self.sync_count = 0
        self.lock_fd = None

    def spawn(self, request):
        argv = request["argv"]
        env = request["env"]
        stdin_bytes = request.get("stdin", "").encode("utf-8", "surrogatepass")
        mode = request.get("tty", "ctty")
        kwargs = {"stdin": subprocess.PIPE, "stdout": subprocess.PIPE, "stderr": subprocess.PIPE, "env": env}
        if mode == "ctty":
            command = argv
        elif mode == "background":
            command = [sys.executable, "-c", BACKGROUND_WRAPPER] + argv
        elif mode == "ancestor":
            command = [sys.executable, "-c", ANCESTOR_WRAPPER] + argv
            kwargs["stderr"] = self.slave
            kwargs["start_new_session"] = True
        else:
            raise ValueError("unknown tty mode %r" % mode)
        popen = subprocess.Popen(command, **kwargs)
        proc_id = self.next_id
        self.next_id += 1
        self.procs[proc_id] = Proc(popen, stdin_bytes)
        return {"id": proc_id, "pid": popen.pid}

    def wait(self, request):
        proc = self.procs[request["id"]]
        try:
            code = proc.popen.wait(timeout=request.get("timeout", 15))
        except subprocess.TimeoutExpired:
            return {"timeout": True}
        for thread in proc.threads:
            thread.join(5)
        if proc.finished is None:
            proc.finished = time.monotonic()
        return {
            "timeout": False,
            "code": code,
            "stdout": proc.stdout.decode("latin-1"),
            "stderr": proc.stderr.decode("utf-8", "replace"),
            "elapsed": proc.finished - proc.started,
            "epipe": proc.epipe,
        }

    def kill(self, request):
        proc = self.procs[request["id"]]
        if proc.popen.poll() is None:
            proc.popen.send_signal(signal.SIGTERM)
            try:
                proc.popen.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.popen.kill()
                proc.popen.wait()
        return {"code": proc.popen.returncode}

    def wchan(self, request):
        try:
            with open("/proc/%d/wchan" % request["pid"]) as handle:
                return {"wchan": handle.read().strip()}
        except OSError:
            return {"wchan": None}

    def drain_available(self):
        while True:
            ready, _, _ = select.select([self.master], [], [], 0)
            if not ready:
                return
            try:
                data = os.read(self.master, 65536)
            except OSError:
                return
            if not data:
                return
            self.captured.extend(data)

    def jam(self, _request):
        # pty 는 flip buffer 를 workqueue 가 master 쪽으로 옮기므로 EAGAIN 뒤에도 자리가 날 수 있다.
        # 잠깐 쉬어도 한 바이트도 못 쓰는 상태가 될 때까지 채운다.
        writer = os.open(self.slave_path, os.O_WRONLY | os.O_NOCTTY | os.O_NONBLOCK)
        filled = 0
        try:
            for _ in range(200):
                progressed = False
                while True:
                    try:
                        os.write(writer, b"x")
                    except BlockingIOError:
                        break
                    filled += 1
                    progressed = True
                if not progressed and filled:
                    break
                time.sleep(0.02)
        finally:
            os.close(writer)
        return {"filled": filled}

    def unjam(self, _request):
        self.drain_available()
        return {}

    def tokens(self, _request):
        self.drain_available()
        self.sync_count += 1
        sentinel = SYNC_PREFIX + b"%d\x07" % self.sync_count
        os.write(self.slave, sentinel)
        deadline = time.monotonic() + 10
        while sentinel not in self.captured:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("pty sync sentinel never arrived")
            ready, _, _ = select.select([self.master], [], [], remaining)
            if ready:
                self.captured.extend(os.read(self.master, 65536))
        return self.parse()

    def parse(self):
        data = bytes(self.captured)
        found = []
        unterminated = False
        index = 0
        while True:
            start = data.find(b"\x1b]", index)
            if start < 0:
                break
            bel = data.find(b"\x07", start)
            escape = data.find(b"\x1b", start + 2)
            if bel < 0 or 0 <= escape < bel:
                unterminated = True
                index = start + 2
                continue
            body = data[start + 2:bel]
            if body.startswith(b"777;notify;"):
                token, _, text = body[len(b"777;notify;"):].partition(b";")
                found.append([token.decode("utf-8", "replace"), text.decode("utf-8", "replace")])
            elif not body.startswith(SYNC_PREFIX[2:]):
                found.append(["?", body.decode("utf-8", "replace")])
            index = bel + 1
        return {"tokens": found, "unterminated": unterminated}

    def lock(self, request):
        fd = os.open(request["path"], os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        self.lock_fd = fd
        return {}

    def unlock(self, _request):
        if self.lock_fd is not None:
            os.close(self.lock_fd)
            self.lock_fd = None
        return {}


def main():
    harness = Harness()
    out = sys.stdout
    out.write(json.dumps({"ready": True, "tty": harness.slave_path}) + "\n")
    out.flush()
    for line in sys.stdin:
        request = json.loads(line)
        try:
            response = getattr(harness, request["op"])(request)
            response["ok"] = True
        except Exception as error:
            response = {"ok": False, "error": "%s: %s" % (type(error).__name__, error)}
        out.write(json.dumps(response) + "\n")
        out.flush()
    for proc in harness.procs.values():
        if proc.popen.poll() is None:
            proc.popen.kill()


if __name__ == "__main__":
    main()
