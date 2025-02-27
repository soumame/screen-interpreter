#!/bin/bash

# This script helps set up a cron job to run the screen interpreter at regular intervals

# Get the absolute path to the run_screen_interpreter.sh script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
INTERPRETER_SCRIPT="$SCRIPT_DIR/run_screen_interpreter.sh"

# Check if the script exists and is executable
if [ ! -x "$INTERPRETER_SCRIPT" ]; then
  echo "Error: $INTERPRETER_SCRIPT does not exist or is not executable"
  exit 1
fi

# Default interval (every 15 minutes)
DEFAULT_INTERVAL="*/15 * * * *"

# Prompt for interval
echo "How often would you like to run the screen interpreter?"
echo "Enter a cron expression (default: $DEFAULT_INTERVAL - every 15 minutes):"
echo "Examples:"
echo "  */5 * * * *     - Every 5 minutes"
echo "  */15 * * * *    - Every 15 minutes"
echo "  0 * * * *       - Every hour"
echo "  0 */2 * * *     - Every 2 hours"
echo "  0 9-17 * * 1-5  - Every hour from 9 AM to 5 PM, Monday to Friday"
read -p "> " CRON_INTERVAL

# Use default if no input
if [ -z "$CRON_INTERVAL" ]; then
  CRON_INTERVAL="$DEFAULT_INTERVAL"
fi

# Create a temporary file for the crontab
TEMP_CRONTAB=$(mktemp)

# Export current crontab to the temporary file
crontab -l > "$TEMP_CRONTAB" 2>/dev/null || echo "" > "$TEMP_CRONTAB"

# Check if the cron job already exists
if grep -q "$INTERPRETER_SCRIPT" "$TEMP_CRONTAB"; then
  echo "A cron job for the screen interpreter already exists."
  echo "Current crontab entries:"
  grep "$INTERPRETER_SCRIPT" "$TEMP_CRONTAB"
  
  read -p "Do you want to replace it? (y/n): " REPLACE
  if [ "$REPLACE" != "y" ]; then
    echo "Operation cancelled."
    rm "$TEMP_CRONTAB"
    exit 0
  fi
  
  # Remove existing entries
  grep -v "$INTERPRETER_SCRIPT" "$TEMP_CRONTAB" > "${TEMP_CRONTAB}.new"
  mv "${TEMP_CRONTAB}.new" "$TEMP_CRONTAB"
fi

# Add the new cron job
echo "# Screen Interpreter - Added $(date)" >> "$TEMP_CRONTAB"
echo "$CRON_INTERVAL $INTERPRETER_SCRIPT >> $SCRIPT_DIR/logs/cron.log 2>&1" >> "$TEMP_CRONTAB"

# Install the new crontab
if crontab "$TEMP_CRONTAB"; then
  echo "Cron job installed successfully!"
  echo "The screen interpreter will run with the following schedule: $CRON_INTERVAL"
  echo "Logs will be written to $SCRIPT_DIR/logs/cron.log"
  echo "To remove this cron job, use:"
  echo "  crontab -l | grep -v -F \"$SCRIPT_DIR\" | crontab -"
else
  echo "Failed to install cron job."
fi

# Clean up
rm "$TEMP_CRONTAB"

# Create logs directory if it doesn't exist
mkdir -p "$SCRIPT_DIR/logs"

echo ""
echo "To manually verify your crontab, run: crontab -l"
echo "To edit your crontab directly, run: crontab -e"
