"""Exercise the immutable public runtime's real Skills tools in a fresh profile."""
import hashlib
import json
import os
from pathlib import Path
import site
import sys

root, profile, expected = map(Path, sys.argv[1:4])
assert root.is_absolute() and profile.is_absolute() and expected.is_absolute()
assert os.environ["HERMES_HOME"] == str(profile)
site.addsitedir(str(root / "dependencies"))
sys.path.insert(0, str(root / "source"))
from tools.skills_tool import skills_list, skill_view  # noqa: E402

listing = json.loads(skills_list())
assert listing["success"] is True
assert any(skill["name"] == "consumer-fixture" for skill in listing["skills"])
view = json.loads(skill_view("consumer-fixture"))
assert view["success"] is True, view
assert view["name"] == "consumer-fixture"
content = expected.read_text(encoding="utf-8")
assert view["content"] == content
assert Path(view["_source_path"]).resolve() == expected.resolve()
assert view["path"] == "registry/consumer-fixture/SKILL.md"
print(json.dumps({"passed": True, "nativeList": True, "nativeView": True,
    "exactImmutableContent": True, "skillSHA256": hashlib.sha256(content.encode()).hexdigest(),
    "gatewayRestart": False, "modelCalled": False}))
