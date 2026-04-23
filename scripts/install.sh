#!/usr/bin/env bash
set -euo pipefail

# Install script for the Agent Orchestrator.
# Wraps configuration validation, image building, and optional setup steps.
#
# Usage: ./scripts/install.sh [--seed-tools] [--up]

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# --- Configuration Validation ---

validate_env() {
  echo "==> Validating configuration..."

  if [[ ! -f .env ]]; then
    echo "Error: .env file not found. Please copy .env.example to .env and fill in the required values."
    exit 1
  fi

  local missing_vars=()
  local warned_vars=()

  # Read .env.example and check for required/optional variables
  while IFS= read -r line || [[ -n "$line" ]]; do
    # Skip truly blank lines
    [[ -z "${line// }" ]] && continue

    # Handle optional variables: lines that start with # but contain =
    if [[ "$line" =~ ^[[:space:]]*#[[:space:]]*([A-Z0-9_]+)= ]]; then
      local actual_key="${BASH_REMATCH[1]}"
      local env_val=$(grep -E "^[[:space:]]*${actual_key}=" .env | head -n 1 | cut -d= -f2- | xargs)
      if [[ -z "$env_val" ]]; then
        warned_vars+=("$actual_key")
      fi
      continue
    fi

    # Handle required variables: lines that do NOT start with # and contain =
    if [[ "$line" =~ ^[[:space:]]*([A-Z0-9_]+)= ]]; then
      local actual_key="${BASH_REMATCH[1]}"
      local env_val=$(grep -E "^[[:space:]]*${actual_key}=" .env | head -n 1 | cut -d= -f2- | xargs)
      if [[ -z "$env_val" ]]; then
        missing_vars+=("$actual_key")
      fi
    fi
  done < .env.example

  if [[ ${#missing_vars[@]} -gt 0 ]]; then
    echo "Error: The following required configuration variables are missing or empty in .env:"
    for var in "${missing_vars[@]}"; do
      echo "  - $var"
    done
    exit 1
  fi

  if [[ ${#warned_vars[@]} -gt 0 ]]; then
    echo "Warning: The following optional configuration variables are missing or empty in .env:"
    for var in "${warned_vars[@]}"; do
      echo "  - $var"
    done
  fi

  echo "All required configuration values present."
}

# --- Build Orchestration ---

build_system() {
  echo "==> Building orchestrator image..."
  docker compose build --no-cache

  echo "==> Building agent images and network..."
  ./scripts/build-agent-images.sh
}

# --- Main ---

SEED_TOOLS=false
UP=false

for arg in "$@"; do
  case $arg in
    --seed-tools) SEED_TOOLS=true ;;
    --up) UP=true ;;
  esac
done

validate_env
build_system

if [[ "$SEED_TOOLS" == true ]]; then
  echo "==> Seeding agent tools..."
  npm run seed:tools
fi

if [[ "$UP" == true ]]; then
  echo "==> Starting orchestrator..."
  docker compose up -d
fi

echo
echo "Installation complete!"
