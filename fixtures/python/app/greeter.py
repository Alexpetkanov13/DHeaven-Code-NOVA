"""Greeting helpers for the NOVA Python fixture."""


def greet(name: str, punctuation: str = "!") -> str:
    """Return the greeting for ``name``."""
    return f"Hello, {name}{punctuation}"


class Greeter:
    def __init__(self, prefix: str) -> None:
        self.prefix = prefix

    def greet_all(self, names: list[str]) -> list[str]:
        return [f"{self.prefix} {greet(n)}" for n in names]
