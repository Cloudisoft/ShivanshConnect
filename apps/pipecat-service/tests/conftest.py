import pytest

from app.config import settings


@pytest.fixture(autouse=True)
def reset_settings():
    """Every test starts from a clean, fully-unconfigured settings
    singleton (matching a fresh, credential-less deployment) and any
    attribute a test sets is reverted afterwards, so tests never leak
    configuration into each other."""
    original = settings.model_dump()
    yield settings
    for key, value in original.items():
        setattr(settings, key, value)
