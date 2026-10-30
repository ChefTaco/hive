# HiveMem tool contract

This registry skill layers operational guidance over the existing HiveMem Hermes plugin. It deliberately does not ship or alter Hermes core code.

- `hermes hivemem status` reports provider configuration.
- `hermes hivemem test --write-check` is the end-to-end diagnostic.
- The installed HiveMem plugin supplies memory tools to Hermes according to its saved provider configuration.

Registry updates replace only this skill directory under `~/.hermes/skills/registry/hivemem`.
