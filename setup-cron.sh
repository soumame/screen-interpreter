#!/bin/bash

# Get the absolute path to the current directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DENO_PATH="$(which deno)"

if [ -z "$DENO_PATH" ]; then
  echo "Error: Deno not found. Please install Deno first."
  echo "Visit https://deno.com/ for installation instructions."
  exit 1
fi

if [ -z "$GEMINI_API_KEY" ]; then
  echo "Warning: GEMINI_API_KEY environment variable is not set."
  echo "You will need to set this before running the application."
  echo "Get a key from https://makersuite.google.com/app/apikey"
  echo ""
fi

# Create the cron job entry
CRON_ENTRY="*/5 * * * * cd $SCRIPT_DIR && $DENO_PATH task start"

# Check if the cron job already exists
EXISTING_CRON=$(crontab -l 2>/dev/null | grep -F "$SCRIPT_DIR")

if [ -n "$EXISTING_CRON" ]; then
  echo "A cron job for this application already exists:"
  echo "$EXISTING_CRON"
  echo ""
  read -p "Do you want to replace it? (y/n): " REPLACE
  if [ "$REPLACE" != "y" ]; then
    echo "Exiting without changes."
    exit 0
  fi
  
  # Remove existing cron job
  crontab -l 2>/dev/null | grep -v -F "$SCRIPT_DIR" | crontab -
fi

# Add the new cron job
(crontab -l 2>/dev/null; echo "$CRON_ENTRY") | crontab -

echo "Cron job set up successfully!"
echo "The application will run every 5 minutes."
echo ""
echo "To view or edit your cron jobs in the future, use:"
echo "  crontab -e"
echo ""
echo "To remove this cron job, use:"
echo "  crontab -l | grep -v -F \"$SCRIPT_DIR\" | crontab -"
