#!/usr/bin/env python3
"""Extract reviewed, tracked public snapshots; never copy checkout-local state.

Development tooling only. The Hive installation controller does not use Python.
"""
import argparse
import hashlib
import io
import json
import pathlib
import subprocess
import tarfile


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def extract(root, revision, prefix, destination, omit=()):
    entries = []
    archive = git(root, "archive", revision, prefix)
    with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
        for member in bundle.getmembers():
            if not member.isfile():
                continue
            relative = pathlib.PurePosixPath(member.name).relative_to(prefix)
            if any(relative == pathlib.PurePosixPath(p) or pathlib.PurePosixPath(p) in relative.parents for p in omit):
                continue
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("Unsafe archive member")
            data = bundle.extractfile(member).read()
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
            entries.append({"path": str(relative), "sha256": hashlib.sha256(data).hexdigest()})
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1])
    parser.add_argument("--destination", type=pathlib.Path, required=True)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()
    revision = git(args.source, "rev-parse", args.revision + "^{commit}").decode().strip()
    products = {
        "Emberpath": ("services/hive-router", ("ui",)),
        "Oathweave": ("services/hive-iam", ()),
        "HiveMem": ("services/hive-mem", ()),
        "HiveSkills": ("services/hive-skills", ()),
        "HiveXUI": ("services/hive-router/ui", ()),
    }
    for name in products:
        destination = args.destination / name
        if destination.exists() and any(destination.iterdir()):
            raise SystemExit(f"Refusing nonempty destination: {name}")
    for name, (prefix, omit) in products.items():
        destination = args.destination / name
        destination.mkdir(parents=True, exist_ok=True)
        entries = extract(args.source, revision, prefix, destination, omit)
        for filename in ("LICENSE", "NOTICE", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", ".gitignore", "AGENTS.md"):
            try:
                data = git(args.source, "show", f"{revision}:{filename}")
            except subprocess.CalledProcessError:
                continue
            output = destination / filename
            if filename == '.gitignore' and output.exists():
                data = output.read_bytes() + b'\n' + data
            output.write_bytes(data)
        write_json(destination / "provenance.json", {
            "schema": 1, "repository": "https://github.com/ChefTaco/hive",
            "revision": revision, "source": prefix, "files": entries,
            "note": "Source snapshot checksums before product-specific changes. No private history or untracked files included.",
        })
        for prefix_common in (".githooks",):
            extract(args.source, revision, prefix_common, destination / prefix_common)
        for filename in ("check-private-data.sh", "scan-secrets.sh"):
            target = destination / "scripts" / filename
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(git(args.source, "show", f"{revision}:scripts/{filename}"))
            target.chmod(0o755)
        (destination / ".gitignore").write_text((destination / ".gitignore").read_text() + "\n*.tsbuildinfo\n.hive/\n")
        subprocess.run(["git", "init", "-b", "main", str(destination)], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(["git", "-C", str(destination), "config", "core.hooksPath", ".githooks"], check=True)
        print(f"Extracted {name}: {len(entries)} public files")
    # Each backend owns a build-time copy of the legacy recovery engine while
    # the new suite controller is introduced. No runtime sibling source imports.
    for name, target, native in (("Emberpath", ".", True), ("Oathweave", "apps/iam-core", True), ("HiveMem", "ts-core", False), ("HiveSkills", ".", False)):
        destination = args.destination / name
        extract(args.source, revision, "packages/hive-release", destination / "tooling/release")
        script = '''import { createRequire } from 'node:module';
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const workspace = join(root, 'tooling/release');
const require = createRequire(join(workspace, 'package.json'));
const { build } = require('esbuild');
const target = join(root, TARGET);
const out = join(target, 'src/release');
if (process.argv.includes('--copy')) {
  const dist = join(target, DIST);
  mkdirSync(dist, { recursive: true });
  copyFileSync(join(out, 'runtime.js'), join(dist, 'runtime.js'));
  copyFileSync(join(workspace, 'node_modules/zod/LICENSE'), join(dist, 'ZOD_LICENSE'));
} else {
  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(workspace, 'tsconfig.json'), '--emitDeclarationOnly'], {stdio:'inherit'});
  if (result.status !== 0) process.exit(result.status || 1);
  mkdirSync(out, {recursive:true});
  await build({ entryPoints:[join(workspace,'src/index.ts')], outfile:join(out,'runtime.js'), bundle:true, format:'esm', platform:'node', target:'node24', NATIVE });
  for (const file of readdirSync(join(workspace,'dist')).filter(f=>f.endsWith('.d.ts')))
    copyFileSync(join(workspace,'dist',file), join(out,file==='index.d.ts'?'runtime.d.ts':file));
}
'''
        dist = "dist/release" if name in ("Oathweave", "HiveSkills") else "dist/src/release"
        script = script.replace("TARGET", json.dumps(target)).replace("DIST", json.dumps(dist)).replace("NATIVE", "alias:{'node:sqlite':join(workspace,'src/sqlite-native.ts')}" if native else "")
        (destination / "scripts/build-release-runtime.mjs").write_text(script)
        package_path = destination / target / "package.json"
        package = json.loads(package_path.read_text())
        relative = "../../" if name == "Oathweave" else "../" if name == "HiveMem" else ""
        for key in ("prebuild", "pretypecheck", "pretest", "postbuild"):
            value = f"node {relative}scripts/build-release-runtime.mjs"
            if key == "postbuild": value += " --copy"
            if name == "Oathweave" and key in ("prebuild", "pretypecheck"): value += " && npm run db:generate"
            package["scripts"][key] = value
        if name in ("Emberpath", "Oathweave"):
            package["name"] = "@hivemagnus/" + name.lower()
            old_bin = "hive-router" if name == "Emberpath" else "hive-iam-server"
            package["bin"][name.lower()] = package["bin"][old_bin]
        package["repository"] = {"type": "git", "url": f"git+https://github.com/ChefTaco/{name}.git"}
        package["homepage"] = f"https://github.com/ChefTaco/{name}#readme"
        write_json(package_path, package)
    # Contract generation reads an owned API snapshot, not another checkout.
    emberpath = args.destination / "Emberpath"
    (emberpath / "contracts").mkdir(exist_ok=True)
    (emberpath / "contracts/oathweave.openapi.json").write_bytes(git(args.source, "show", f"{revision}:docs/openapi/iam.openapi.json"))
    generator = emberpath / "scripts/generate-ui-contracts.ts"
    value = generator.read_text().replace("import { buildOpenApiSpec } from '../../hive-iam/apps/iam-core/src/openapi/spec.js';", "const buildOpenApiSpec = () => JSON.parse(readFileSync(new URL('../contracts/oathweave.openapi.json', import.meta.url), 'utf8'));")
    generator.write_text(value)
    package = json.loads((emberpath / "package.json").read_text())
    package["scripts"]["build"] = "npm run build:server"
    package["scripts"]["typecheck"] = "npm run db:generate && npm run contracts:check && tsc --project tsconfig.json --noEmit"
    for key in ("dev:ui", "build:ui"): package["scripts"].pop(key, None)
    package["files"] = [p for p in package["files"] if p != "ui/dist"]
    package["description"] = "Emberpath: OpenAI-compatible model routing, providers, quotas and telemetry."
    write_json(emberpath / "package.json", package)
    config = json.loads((emberpath / "tsconfig.json").read_text())
    config["include"].remove("ui/vite.config.ts")
    write_json(emberpath / "tsconfig.json", config)
    ui = args.destination / "HiveXUI"
    extract(args.source, revision, "services/hive-router/src/contracts", ui / "contracts")
    config = json.loads((ui / "tsconfig.json").read_text())
    config["compilerOptions"]["paths"]["@contracts/*"] = ["./contracts/*"]
    write_json(ui / "tsconfig.json", config)
    vite = (ui / "vite.config.ts").read_text().replace("'../src/contracts'", "'./contracts'")
    (ui / "vite.config.ts").write_text(vite)
    source_package = json.loads((emberpath / "package.json").read_text())
    dependencies = {key: source_package["devDependencies"][key] for key in ("react", "react-dom")}
    dependencies["zod"] = source_package["dependencies"]["zod"]
    dev = {key: source_package["devDependencies"][key] for key in ("@types/node", "@types/react", "@types/react-dom", "@vitejs/plugin-react", "typescript", "vite", "vitest", "@playwright/test")}
    write_json(ui / "package.json", {"name": "@hivemagnus/hivexui", "version": "0.1.0", "private": True, "type": "module", "license": "Apache-2.0", "scripts": {"dev": "vite --host 127.0.0.1", "typecheck": "tsc --noEmit", "build": "npm run typecheck && vite build", "test": "vitest run", "scan:secrets": "bash scripts/scan-secrets.sh", "check:private": "bash scripts/check-private-data.sh"}, "dependencies": dependencies, "devDependencies": dev})


if __name__ == "__main__":
    main()
