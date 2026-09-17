"""
Phase 10 unit tests for supervisor_hub.py in isolation - no WS, no
pipecat-ai, no network.
"""

import asyncio

import pytest

from app.supervisor_hub import SupervisorHub


class FakeWebSocket:
    def __init__(self, fail: bool = False):
        self.sent: list[bytes] = []
        self.fail = fail

    async def send_bytes(self, data: bytes) -> None:
        if self.fail:
            raise RuntimeError("socket gone")
        self.sent.append(data)


def test_drain_injection_audio_returns_none_when_nothing_queued():
    hub = SupervisorHub()
    assert hub.drain_injection_audio("pc_1") is None


def test_whisper_audio_is_queued_and_drained_fifo():
    hub = SupervisorHub()
    hub.push_whisper_audio("pc_1", b"a")
    hub.push_whisper_audio("pc_1", b"b")
    assert hub.drain_injection_audio("pc_1") == b"a"
    assert hub.drain_injection_audio("pc_1") == b"b"
    assert hub.drain_injection_audio("pc_1") is None


def test_whisper_takes_priority_over_barge_audio():
    hub = SupervisorHub()
    hub.push_barge_audio("pc_1", b"barge-frame")
    hub.push_whisper_audio("pc_1", b"whisper-frame")
    # A supervisor whispering a correction mid-barge is still heard first.
    assert hub.drain_injection_audio("pc_1") == b"whisper-frame"
    assert hub.drain_injection_audio("pc_1") == b"barge-frame"


def test_calls_are_isolated_from_each_other():
    hub = SupervisorHub()
    hub.push_whisper_audio("pc_1", b"for-call-1")
    assert hub.drain_injection_audio("pc_2") is None
    assert hub.drain_injection_audio("pc_1") == b"for-call-1"


@pytest.mark.asyncio
async def test_broadcast_audio_reaches_every_connected_listener_with_a_direction_tag():
    hub = SupervisorHub()
    ws1, ws2 = FakeWebSocket(), FakeWebSocket()
    hub.add_listener("pc_1", ws1)
    hub.add_listener("pc_1", ws2)

    await hub.broadcast_audio("pc_1", "caller", b"\x11\x22")
    await hub.broadcast_audio("pc_1", "ai", b"\x33\x44")

    assert ws1.sent == [b"\x00\x11\x22", b"\x01\x33\x44"]
    assert ws2.sent == [b"\x00\x11\x22", b"\x01\x33\x44"]


@pytest.mark.asyncio
async def test_broadcast_audio_is_a_no_op_with_no_listeners():
    hub = SupervisorHub()
    # Never raises, never queues anything for later - a supervisor who
    # connects after this point simply doesn't get frames that already
    # went by, exactly like joining a live call late.
    await hub.broadcast_audio("pc_1", "caller", b"\x01")


@pytest.mark.asyncio
async def test_broadcast_audio_drops_a_dead_socket_without_affecting_the_others():
    hub = SupervisorHub()
    good, dead = FakeWebSocket(), FakeWebSocket(fail=True)
    hub.add_listener("pc_1", good)
    hub.add_listener("pc_1", dead)

    await hub.broadcast_audio("pc_1", "ai", b"\x01")

    assert good.sent == [b"\x01\x01"]
    state = hub._calls["pc_1"]
    assert dead not in state.listeners
    assert good in state.listeners


def test_discard_call_clears_all_state():
    hub = SupervisorHub()
    hub.push_whisper_audio("pc_1", b"x")
    hub.add_listener("pc_1", FakeWebSocket())
    hub.set_barge_active("pc_1", True)

    hub.discard_call("pc_1")

    assert hub.drain_injection_audio("pc_1") is None
    assert "pc_1" not in hub._calls
