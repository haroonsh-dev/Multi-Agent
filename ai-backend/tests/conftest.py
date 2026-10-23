"""Make the ai-backend package importable from tests regardless of cwd.

`python -m pytest` already puts the current directory on sys.path; this file
keeps `pytest tests/...` (without -m) and IDE runners working too.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
