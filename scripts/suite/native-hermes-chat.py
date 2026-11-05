"""Bounded actual Hermes adapter and authorization proof; no model or gateway rollout."""
import asyncio
import json
import logging
import os
from pathlib import Path
import site
import sys
import time

root, input_file = map(Path, sys.argv[1:3])
site.addsitedir(str(root / "dependencies"))
sys.path.insert(0, str(root / "source"))
logging.basicConfig(level=logging.INFO)
settings = json.loads(input_file.read_text())
assert os.environ["HERMES_HOME"] == settings["profile"]
from gateway.authz_mixin import GatewayAuthorizationMixin  # noqa: E402
from gateway.config import GatewayConfig, Platform, PlatformConfig  # noqa: E402
from plugins.platforms.mattermost.adapter import MattermostAdapter  # noqa: E402
from tools.skills_tool import skill_view  # noqa: E402


async def main():
    config = PlatformConfig(enabled=True, token=settings["token"], extra={
        "url": settings["origin"], "allowed_users": [settings["allowedUser"]]})
    adapter = MattermostAdapter(config)
    # This is the unchanged authorization implementation mixed into GatewayRunner.
    # Only its real adapter/config inputs are supplied; no policy method is replaced.
    authorization = GatewayAuthorizationMixin()
    authorization.adapters = {Platform.MATTERMOST: adapter}
    authorization.config = GatewayConfig()
    accepted, rejected = [], []

    async def consume(event):
        logging.info("Fixture received user=%s authorized=%s", event.source.user_id, authorization._is_user_authorized(event.source))
        if not authorization._is_user_authorized(event.source):
            rejected.append(event.source.user_id)
            return None
        assert event.source.user_id == settings["allowedUser"]
        assert event.text == "HERMES-ALLOWED-CONSUMER"
        skill = json.loads(skill_view("consumer-fixture"))
        assert skill["success"] and settings["skillMarker"] in skill["content"]
        reply = await adapter.send(event.source.chat_id, "HERMES-CONSUMER-SKILL-VERIFIED")
        assert reply.success and reply.message_id
        accepted.append(event.source.user_id)
        return None

    adapter.set_message_handler(consume)
    try:
        assert await adapter.connect(), "Actual Hermes adapter authentication failed"
        assert adapter._bot_user_id == settings["botId"]
        deadline = time.monotonic() + 20
        while adapter._ws is None or adapter._ws.closed:
            assert time.monotonic() < deadline
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.2)
        Path(settings["ready"]).write_text("ready")
        while not (accepted and rejected):
            assert time.monotonic() < deadline, f"Missing native events: accepted={len(accepted)} rejected={len(rejected)}"
            await asyncio.sleep(0.05)
        assert accepted == [settings["allowedUser"]]
        assert rejected == [settings["forbiddenUser"]]
        print(json.dumps({"passed": True, "actualBundledAdapter": True,
            "verifiedTLS": True, "nativeBotAuthentication": True,
            "nativeWebSocketReceive": True, "nativeRestReply": True,
            "nativeAuthorizationAllowlist": True, "exactSyncedSkillConsumed": True,
            "gatewayRestart": False, "modelCalled": False}))
    finally:
        await adapter.disconnect()


asyncio.run(main())
