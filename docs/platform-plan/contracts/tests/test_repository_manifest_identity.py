"""Actual organization support repo identity must validate without fake names."""
import json,re
from pathlib import Path
import pytest
SCHEMA=json.loads((Path(__file__).resolve().parents[1]/'project-manifest.schema.json').read_text())
@pytest.mark.parametrize('name',['FreeTWAI-AI/.github','FreeTWAI-AI/freedom-platform','FreeTWAI-AI/FreeTWAI-AI.github.io'])
def test_real_repo_name_and_url_forms(name):
 assert re.fullmatch(SCHEMA['$defs']['github_repository_name']['pattern'],name)
 assert re.fullmatch(SCHEMA['$defs']['github_repository_url']['pattern'],'https://github.com/'+name)
@pytest.mark.parametrize('name',['FreeTWAI-AI/..','FreeTWAI-AI/.','FreeTWAI-AI/.github/other'])
def test_invalid_repo_paths_stay_rejected(name):
 assert not re.fullmatch(SCHEMA['$defs']['github_repository_name']['pattern'],name)
 assert not re.fullmatch(SCHEMA['$defs']['github_repository_url']['pattern'],'https://github.com/'+name)
