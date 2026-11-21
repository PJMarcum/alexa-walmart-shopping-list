import pathlib
import sys

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "apps"))
