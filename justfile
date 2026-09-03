# Dispatcher development commands.

# Run recipes through PowerShell 7 on Windows (recipes use `&&`, which the
# legacy Windows PowerShell 5.1 cannot parse).
set windows-shell := ["pwsh.exe", "-NoLogo", "-NoProfile", "-Command"]

# List available recipes.
default:
  {{just_executable()}} --list

# Install dependencies.
install:
  bun install

# TypeScript type checking.
typecheck:
  bun run tsc --noEmit

# Run the test suite (vitest, with coverage).
test:
  bun run vitest run --coverage

# Run all quality checks.
check: typecheck test

# Run the CLI from source: `just run board config`, `just run status`, ...
run *args:
  bun run tsx src/main.ts {{args}}

# Compile the CLI into self-contained executables under dist/
# (dispatcher-<target>, `.exe` on Windows) - every subcommand in one binary.
# No arguments compiles the host platform; pass target keys (windows-x64,
# linux-x64, linux-arm64, darwin-x64, darwin-arm64) or `all`. Cross-compiling
# works from any host - bun downloads the target runtime.
compile *targets:
  bun run tsx scripts/compile.ts {{targets}}

# Serve the documentation site locally (website/, Docusaurus) with live reload.
docs:
  cd website && bun install && bun run start

# Build the documentation site into website/build, exactly as the Pages workflow does.
docs-build:
  cd website && bun install --frozen-lockfile && bun run typecheck && bun run build
