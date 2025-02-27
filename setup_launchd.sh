#!/bin/bash

# This script helps set up a launchd job to run the screen interpreter at regular intervals

# Get the absolute path to the run_screen_interpreter.sh script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INTERPRETER_SCRIPT="$SCRIPT_DIR/run_screen_interpreter.sh"
PLIST_TEMPLATE="$SCRIPT_DIR/com.screen-interpreter.plist"
LOGS_DIR="$SCRIPT_DIR/logs"

# Check if the script exists and is executable
if [ ! -x "$INTERPRETER_SCRIPT" ]; then
  echo "Error: $INTERPRETER_SCRIPT does not exist or is not executable"
  exit 1
fi

# Check if the plist template exists
if [ ! -f "$PLIST_TEMPLATE" ]; then
  echo "Error: $PLIST_TEMPLATE does not exist"
  exit 1
fi

# Create logs directory if it doesn't exist
mkdir -p "$LOGS_DIR"

# Default interval (every 15 minutes = 900 seconds)
DEFAULT_INTERVAL=900

# Prompt for interval
echo "How often would you like to run the screen interpreter?"
echo "Enter interval in seconds (default: $DEFAULT_INTERVAL - every 15 minutes):"
echo "Examples:"
echo "  300     - Every 5 minutes"
echo "  900     - Every 15 minutes"
echo "  3600    - Every hour"
echo "  7200    - Every 2 hours"
read -p "> " INTERVAL_SECONDS

# Use default if no input
if [ -z "$INTERVAL_SECONDS" ]; then
  INTERVAL_SECONDS="$DEFAULT_INTERVAL"
fi

# Create a temporary directory
TEMP_DIR=$(mktemp -d)
PLIST_FILE="$TEMP_DIR/com.screen-interpreter.plist"

# Create the plist file from the template
cp "$PLIST_TEMPLATE" "$PLIST_FILE"

# Replace placeholders in the plist file
sed -i '' "s|SCRIPT_PATH|$INTERPRETER_SCRIPT|g" "$PLIST_FILE"
sed -i '' "s|LOGS_PATH|$LOGS_DIR|g" "$PLIST_FILE"
sed -i '' "s|<integer>900</integer>|<integer>$INTERVAL_SECONDS</integer>|g" "$PLIST_FILE"

# Define the destination for the plist file
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/com.screen-interpreter.plist"

# Check if the launchd job already exists
if [ -f "$LAUNCHD_PLIST" ]; then
  echo "A launchd job for the screen interpreter already exists."
  
  read -p "Do you want to replace it? (y/n): " REPLACE
  if [ "$REPLACE" != "y" ]; then
    echo "Operation cancelled."
    rm -rf "$TEMP_DIR"
    exit 0
  fi
  
  # Unload the existing job
  launchctl unload "$LAUNCHD_PLIST"
  rm "$LAUNCHD_PLIST"
fi

# Copy the plist file to the LaunchAgents directory
mkdir -p "$HOME/Library/LaunchAgents"
cp "$PLIST_FILE" "$LAUNCHD_PLIST"

# Load the launchd job
if launchctl load "$LAUNCHD_PLIST"; then
  echo "Launchd job installed successfully!"
  echo "The screen interpreter will run every $(($INTERVAL_SECONDS / 60)) minutes"
  echo "Logs will be written to $LOGS_DIR/launchd.log"
  echo ""
  echo "To remove this launchd job, run:"
  echo "  launchctl unload $LAUNCHD_PLIST"
  echo "  rm $LAUNCHD_PLIST"
else
  echo "Failed to install launchd job."
fi

# Clean up
rm -rf "$TEMP_DIR"

echo ""
echo "To check if your launchd job is running, use: launchctl list | grep com.screen-interpreter"
