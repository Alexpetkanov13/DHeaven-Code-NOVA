import os

import pytest

from app.greeter import Greeter, greet


def test_greets_by_name():
    print("greeting NOVA")
    assert greet("NOVA") == "Hello, NOVA!"


@pytest.mark.parametrize("name", ["Java", "Rust"])
def test_greets_each(name):
    assert greet(name).endswith(f"{name}!")


@pytest.mark.skip(reason="not implemented yet")
def test_not_yet():
    pass


class TestGreeter:
    def test_prefix(self):
        assert Greeter(">").greet_all(["A"]) == ["> Hello, A!"]

    @pytest.mark.skipif(os.environ.get("NOVA_DEMO_FAIL") != "1", reason="set NOVA_DEMO_FAIL=1 to see a failure")
    def test_deliberate_failure(self):
        assert greet("NOVA", "?") == "Hello, NOVA!"
