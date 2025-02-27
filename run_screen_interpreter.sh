#!/bin/bash

# Set the working directory to the script's directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Load environment variables from .env file
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# Check if GEMINI_API_KEY is set
if [ -z "$GEMINI_API_KEY" ]; then
  echo "Error: GEMINI_API_KEY is not set in .env file"
  exit 1
fi

# Run the Deno application
echo "Running screen interpreter at $(date)"
deno run --allow-env --allow-read --allow-write --allow-run --allow-net src/main.ts

echo "Screen interpreter completed at $(date)"
