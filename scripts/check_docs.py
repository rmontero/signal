#!/usr/bin/env python3
"""Check the Signal documentation handoff without installing app dependencies."""

from pathlib import Path
import json
import re
import sys
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = [
    "README.md", "AGENTS.md", "north_star.md", "roadmap.md", "tasks.md",
    "northstar.md", "docs/PRODUCT.md", "docs/ARCHITECTURE.md",
    "docs/CONTRACTS.md", "docs/INFRASTRUCTURE.md", "docs/INTEGRATIONS.md",
    "docs/VERIFICATION.md", "docs/OPERATIONS.md", "docs/DEMO.md", "docs/SAAS.md",
    "docs/superpowers/plans/2026-09-11-signal.md",
    "docs/reference/original-brief.md", "docs/reference/prior-plan.md",
    ".env.example", ".gitignore", ".nvmrc", "CLAUDE.md", "config/pilot.example.json",
    "docs/HANDOFF.md",
]
IGNORED_PARTS = {
    ".git", "node_modules", ".next", ".venv", ".superpowers", ".agent-work",
}
errors: list[str] = []


def fail(message: str) -> None:
    errors.append(message)


def without_fences(text: str) -> str:
    return re.sub(r"^```[^\n]*\n.*?^```\s*$", "", text, flags=re.M | re.S)


def heading_slugs(text: str) -> set[str]:
    slugs: set[str] = set()
    counts: dict[str, int] = {}
    for heading in re.findall(r"^#{1,6}\s+(.+?)\s*#*\s*$", without_fences(text), re.M):
        slug = re.sub(r"[^\w\- ]", "", heading.lower()).replace(" ", "-")
        count = counts.get(slug, 0)
        counts[slug] = count + 1
        slugs.add(slug if count == 0 else f"{slug}-{count}")
    return slugs


for name in REQUIRED:
    path = ROOT / name
    if not path.is_file():
        fail(f"Missing required file: {name}")
    elif not path.read_text().strip():
        fail(f"Empty required file: {name}")

markdown = sorted(
    path for path in ROOT.rglob("*.md")
    if not any(part in IGNORED_PARTS for part in path.relative_to(ROOT).parts)
)
for path in markdown:
    text = path.read_text()
    relative = path.relative_to(ROOT)
    if not re.search(r"^#\s+\S", text, re.M):
        fail(f"No document title: {relative}")
    for label, raw_target in re.findall(r"\[([^\]]+)\]\(([^)]+)\)", without_fences(text)):
        target = raw_target.strip()
        if target.startswith("<") and ">" in target:
            target = target[1:target.index(">")]
        else:
            target = re.split(r'\s+[\"\']', target, maxsplit=1)[0]
        parsed = urlsplit(target)
        if parsed.scheme or parsed.netloc:
            continue
        destination = (path.parent / unquote(parsed.path)).resolve() if parsed.path else path
        if not destination.exists():
            fail(f"Broken link in {relative}: {label} -> {target}")
        elif parsed.fragment and destination.suffix == ".md":
            if unquote(parsed.fragment) not in heading_slugs(destination.read_text()):
                fail(f"Missing heading in link from {relative}: {target}")
    if "reference" not in relative.parts and "reviews" not in relative.parts:
        # Task status TODO is legitimate; unresolved placeholder prose is not.
        if re.search(r"\bTBD\b|\bFIXME\b|\[INSERT\b|<fill.in", text, re.I):
            fail(f"Unresolved placeholder in {relative}")

product = ROOT / "docs/PRODUCT.md"
verification = ROOT / "docs/VERIFICATION.md"
if product.exists() and verification.exists():
    spec_text, checks_text = product.read_text(), verification.read_text()
    for number in range(1, 16):
        requirement = f"MVP-{number:02}"
        if requirement not in spec_text:
            fail(f"Product requirement absent: {requirement}")
        if requirement not in checks_text:
            fail(f"Verification mapping absent: {requirement}")

integrations = ROOT / "docs/INTEGRATIONS.md"
if integrations.exists():
    text = integrations.read_text().lower()
    for partner in ["openai", "copilotkit", "openrouter", "exa", "trigger.dev", "auth0", "mozilla", "ambiguous"]:
        if partner not in text:
            fail(f"Integration missing from matrix: {partner}")

if (ROOT / "northstar.md").exists():
    if "north_star.md" not in (ROOT / "northstar.md").read_text():
        fail("Legacy northstar.md must point to canonical north_star.md")

pilot = ROOT / "config/pilot.example.json"
if pilot.exists():
    try:
        config = json.loads(pilot.read_text())
        for key in ["tenantId", "slackTeamId", "workspaceTimezone", "channels", "identities"]:
            if key not in config:
                fail(f"Pilot example missing field: {key}")
        if not isinstance(config.get("channels"), list) or not config["channels"]:
            fail("Pilot example must show a channel mapping")
    except (ValueError, TypeError) as error:
        fail(f"Invalid pilot example JSON: {error}")

if (ROOT / ".env.example").exists() and (ROOT / "docs/INFRASTRUCTURE.md").exists():
    env_text = (ROOT / ".env.example").read_text()
    infra_text = (ROOT / "docs/INFRASTRUCTURE.md").read_text()
    for name in re.findall(r"^([A-Z][A-Z0-9_]*)=", env_text, re.M):
        if name not in infra_text:
            fail(f"Environment setting undocumented in INFRASTRUCTURE: {name}")

if errors:
    for error in errors:
        print(f"FAIL: {error}")
    print(f"\nDocumentation check failed: {len(errors)} issue(s).")
    sys.exit(1)

print(f"PASS: {len(REQUIRED)} required files; {len(markdown)} Markdown documents; local links, titles, requirement coverage, partner coverage and environment names.")
print("This verifies documentation structure only. Application builds, tests and live integrations are separate gates.")
