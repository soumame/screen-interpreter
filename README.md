# Screen Interpreter

> Made by Cline(AI)

A Deno application that takes screenshots at regular intervals, analyzes them using Gemini Flash, and logs screen activity information.

## Features

- Takes screenshots every 5 minutes (when set up with cron)
- Uses macOS native commands to capture screen content
- Retrieves information about open applications
- Analyzes screenshots using Google's Gemini Flash API
- Logs detailed activity information including:
  - Timestamp
  - Screenshot path
  - Open applications and window titles
  - AI-generated description of screen content

## Prerequisites

- macOS (for the `screencapture` command and AppleScript)
- [Deno](https://deno.com/) installed
- Google Gemini API key

## Setup

1. Clone this repository
2. Get a Gemini API key from [Google AI Studio](https://makersuite.google.com/app/apikey)
3. Set the API key as an environment variable:

```bash
export GEMINI_API_KEY="your-api-key-here"
```

Alternatively, you can create a `.env` file based on the provided `.env.example`:

```bash
cp .env.example .env
```

Then edit the `.env` file to add your API key.

## Usage

### Running Manually

To run the application once:

```bash
deno task start
```

This will:

1. Take a screenshot
2. Get information about open applications
3. Analyze the screenshot using Gemini Flash
4. Log the activity information

### Setting Up Scheduled Runs

To run the application every 5 minutes, you can use the provided setup script:

```bash
./setup-cron.sh
```

This script will:

- Check if Deno is installed
- Verify if the GEMINI_API_KEY environment variable is set
- Create a cron job to run the application every 5 minutes

Alternatively, you can manually set up a cron job:

1. Open your crontab file:

```bash
crontab -e
```

2. Add the following line (adjust the paths as needed):

```
*/5 * * * * cd /path/to/screen-interpreter && /path/to/deno task start
```

3. Save and exit

## Output

The application creates two directories:

- `screenshots/`: Contains all captured screenshots with timestamps
- `logs/`: Contains JSON log files with activity information

Each log entry includes:

- Timestamp
- Path to the screenshot
- List of open applications and their window titles
- AI-generated analysis of the screen content

## License

MIT
