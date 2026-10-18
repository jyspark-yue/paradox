import os
import tempfile
from pathlib import Path

import pytest

_tmp = Path(tempfile.mkdtemp(prefix="paradox-test-"))
os.environ.setdefault("PARADOX_DB_PATH", str(_tmp / "test.db"))
os.environ["PARADOX_LLM"] = "off"

from paradox.service import InvestigationService  # noqa: E402


@pytest.fixture
def service():
    return InvestigationService(graph_prefix="paradox_test")


@pytest.fixture
def case1(service):
    service.start("case001", variant="A")
    return service


@pytest.fixture
def case2(service):
    service.start("case002", variant="A")
    return service
