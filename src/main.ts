import { ensureDir, exists } from "std/fs";
import { join } from "std/path";
import { load } from "std/dotenv";
import { format } from "std/datetime";

// Load environment variables from .env file if it exists
try {
  await load({ export: true });
} catch (error) {
  // .env file might not exist, which is fine if env vars are set another way
  console.log("No .env file found. Using existing environment variables.");
}

// Configuration
const SCREENSHOTS_DIR = "./screenshots";
const LOGS_DIR = "./logs";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const AFK_TIMEOUT_MINUTES = parseInt(
  Deno.env.get("AFK_TIMEOUT_MINUTES") || "5",
  10
);
const SUMMARY_INTERVAL_MINUTES = parseInt(
  Deno.env.get("SUMMARY_INTERVAL_MINUTES") || "60",
  10
);

// Ensure directories exist
await ensureDir(SCREENSHOTS_DIR);
await ensureDir(LOGS_DIR);

/**
 * Gets the time of the last user input event in milliseconds since epoch
 * @returns Time of last input in milliseconds
 */
async function getLastInputTime(): Promise<number> {
  try {
    // Use ioreg to get HID (Human Interface Device) System events
    const command = new Deno.Command("ioreg", {
      args: ["-c", "IOHIDSystem"],
      stdout: "piped",
    });

    const { stdout } = await command.output();
    const output = new TextDecoder().decode(stdout);

    // Look for HIDIdleTime which represents time since last input in nanoseconds
    const match = output.match(/"HIDIdleTime" = (\d+)/);

    if (match && match[1]) {
      // Convert nanoseconds to milliseconds and subtract from current time
      const idleTimeNs = parseInt(match[1], 10);
      const idleTimeMs = idleTimeNs / 1000000; // Convert nanoseconds to milliseconds
      const lastInputTime = Date.now() - idleTimeMs;

      return lastInputTime;
    }

    // If we couldn't get the idle time, return current time (assume user is active)
    return Date.now();
  } catch (error) {
    console.error("Error getting last input time:", error);
    // In case of error, return current time (assume user is active)
    return Date.now();
  }
}

/**
 * Checks if the user is currently AFK (Away From Keyboard)
 * @returns True if user is AFK, false otherwise
 */
async function isUserAFK(): Promise<boolean> {
  const lastInputTime = await getLastInputTime();
  const currentTime = Date.now();
  const idleTimeMinutes = (currentTime - lastInputTime) / (1000 * 60);

  console.log(`User has been idle for ${idleTimeMinutes.toFixed(2)} minutes`);

  return idleTimeMinutes >= AFK_TIMEOUT_MINUTES;
}

/**
 * Takes a screenshot and saves it to the screenshots directory
 * @returns Path to the saved screenshot
 */
async function takeScreenshot(): Promise<string> {
  const timestamp = new Date().toISOString().replace(/:/g, "-");
  const filename = `screenshot_${timestamp}.png`;
  const filepath = join(SCREENSHOTS_DIR, filename);

  const command = new Deno.Command("screencapture", {
    args: ["-x", filepath], // -x for silent capture (no sound)
  });

  const { code } = await command.output();

  if (code !== 0) {
    throw new Error(`Failed to take screenshot, exit code: ${code}`);
  }

  console.log(`Screenshot saved to ${filepath}`);
  return filepath;
}

/**
 * Optimizes an image by adjusting its quality and size for API transmission
 * @param imagePath Path to the original image
 * @returns Path to the optimized image
 */
async function optimizeImage(imagePath: string): Promise<string> {
  // Create a new filename for the optimized image
  const pathParts = imagePath.split(".");
  const extension = pathParts.pop();
  const optimizedPath = `${pathParts.join(".")}_optimized.${extension}`;

  // Use sips (built into macOS) to resize the image while maintaining aspect ratio
  // This will reduce the file size significantly
  const resizeCommand = new Deno.Command("sips", {
    args: [
      "--resampleWidth",
      "1200", // Resize to 1200px width (adjust as needed)
      "--setProperty",
      "formatOptions",
      "80", // Set quality to 80% (for JPG)
      imagePath,
      "--out",
      optimizedPath,
    ],
  });

  const { code } = await resizeCommand.output();

  if (code !== 0) {
    console.warn(
      `Failed to optimize image, using original. Exit code: ${code}`
    );
    return imagePath; // Return original path if optimization fails
  }

  console.log(`Image optimized and saved to ${optimizedPath}`);
  return optimizedPath;
}

/**
 * Gets information about currently open applications
 * @returns Array of application information objects
 */
async function getOpenApplications(): Promise<
  Array<{ name: string; title?: string; isFrontmost: boolean }>
> {
  // Get the frontmost application using AppleScript
  const frontmostScript = `
    tell application "System Events"
      set frontApp to first application process whose frontmost is true
      set frontAppName to name of frontApp
      set windowTitle to ""
      try
        set windowTitle to name of front window of frontApp
      end try
      return {name:frontAppName, title:windowTitle}
    end tell
  `;

  const frontmostCommand = new Deno.Command("osascript", {
    args: ["-e", frontmostScript],
    stdout: "piped",
  });

  const { stdout: frontmostStdout } = await frontmostCommand.output();
  const frontmostOutput = new TextDecoder().decode(frontmostStdout).trim();

  // Parse the frontmost app info
  const frontmostMatch = frontmostOutput.match(
    /\{name:([^,]+), title:([^}]*)\}/
  );
  let frontmostApp = null;

  if (frontmostMatch) {
    const name = frontmostMatch[1].replace(/"/g, "").trim();
    const title = frontmostMatch[2].replace(/"/g, "").trim();
    frontmostApp = { name, title: title || undefined, isFrontmost: true };
  }

  // Get all non-background applications using AppleScript
  const nonBackgroundAppsCommand = new Deno.Command("osascript", {
    args: [
      "-e",
      'tell application "System Events" to get name of every process where background only is false',
    ],
    stdout: "piped",
  });

  const { stdout: nonBackgroundAppsStdout } =
    await nonBackgroundAppsCommand.output();
  const nonBackgroundAppsOutput = new TextDecoder()
    .decode(nonBackgroundAppsStdout)
    .trim();

  // Parse the output (format is typically a comma-separated list)
  const appNames = nonBackgroundAppsOutput
    .replace(/^{|}$/g, "") // Remove the curly braces if present
    .split(", ")
    .map((name) => name.replace(/^"|"$/g, "").trim()) // Remove quotes
    .filter((name) => name); // Remove empty strings

  // Get window titles for each application
  const apps = [];

  for (const appName of appNames) {
    // Skip if this is the frontmost app (we already have its info)
    if (
      frontmostApp &&
      frontmostApp.name.toLowerCase() === appName.toLowerCase()
    ) {
      apps.push(frontmostApp);
      continue;
    }

    // Get window title for this app
    const windowTitleScript = `
      tell application "System Events"
        set windowTitle to ""
        try
          tell process "${appName.replace(/"/g, '\\"')}"
            if exists window 1 then
              set windowTitle to name of window 1
            end if
          end tell
        end try
        return windowTitle
      end tell
    `;

    try {
      const windowTitleCommand = new Deno.Command("osascript", {
        args: ["-e", windowTitleScript],
        stdout: "piped",
      });

      const { stdout: windowTitleStdout } = await windowTitleCommand.output();
      const windowTitle = new TextDecoder()
        .decode(windowTitleStdout)
        .trim()
        .replace(/^"|"$/g, "");

      apps.push({
        name: appName,
        title: windowTitle || undefined,
        isFrontmost: false,
      });
    } catch (error) {
      // If we can't get the window title, just add the app name
      apps.push({
        name: appName,
        isFrontmost: false,
      });
    }
  }

  return apps;
}

/**
 * Reads the most recent activity log
 * @returns The most recent activity log entry or null if none exists
 */
async function getRecentActivity(): Promise<any | null> {
  // Get the current date in YYYY-MM-DD format
  const today = new Date().toISOString().split("T")[0];
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = yesterdayDate.toISOString().split("T")[0];

  // Check today's log first, then yesterday's
  const todayLogPath = join(LOGS_DIR, `activity_${today}.log`);
  const yesterdayLogPath = join(LOGS_DIR, `activity_${yesterday}.log`);

  let logPath = "";
  if (await exists(todayLogPath)) {
    logPath = todayLogPath;
  } else if (await exists(yesterdayLogPath)) {
    logPath = yesterdayLogPath;
  } else {
    return null; // No recent logs found
  }

  try {
    const logContent = await Deno.readTextFile(logPath);
    // Split by newlines and get the last non-empty entry
    const entries = logContent.split("\n").filter((line) => line.trim());
    if (entries.length === 0) return null;

    // Parse the most recent entry
    return JSON.parse(entries[entries.length - 1]);
  } catch (error) {
    console.error("Error reading recent activity log:", error);
    return null;
  }
}

/**
 * Reads activity logs from a specific time period
 * @param startTime The start time of the period
 * @param endTime The end time of the period
 * @returns Array of activity log entries
 */
async function getActivitiesInTimeRange(
  startTime: Date,
  endTime: Date
): Promise<any[]> {
  const activities: any[] = [];

  // Get all dates in the range (could span multiple days)
  const dates: string[] = [];
  const currentDate = new Date(startTime);

  while (currentDate <= endTime) {
    dates.push(currentDate.toISOString().split("T")[0]);
    currentDate.setDate(currentDate.getDate() + 1);
  }

  // Read logs for each date
  for (const date of dates) {
    const logPath = join(LOGS_DIR, `activity_${date}.log`);

    if (await exists(logPath)) {
      try {
        const logContent = await Deno.readTextFile(logPath);
        const entries = logContent
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));

        // Filter entries by timestamp
        const filteredEntries = entries.filter((entry) => {
          const entryTime = new Date(entry.timestamp);
          return entryTime >= startTime && entryTime <= endTime;
        });

        activities.push(...filteredEntries);
      } catch (error) {
        console.error(`Error reading activity log for ${date}:`, error);
      }
    }
  }

  // Sort by timestamp
  activities.sort((a, b) => {
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });

  return activities;
}

/**
 * Generates a summary of activities from a list of activity logs
 * @param activities Array of activity log entries
 * @returns Summary text
 */
async function generateActivitySummary(activities: any[]): Promise<string> {
  if (!activities.length) {
    return "この時間帯のアクティビティはありませんでした。";
  }

  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY environment variable is not set");
  }

  // Extract all screen analyses
  const screenAnalyses = activities.map((activity) => activity.screenAnalysis);

  // Create a prompt for Gemini to summarize the activities
  const prompt = `
以下は過去${SUMMARY_INTERVAL_MINUTES}分間のスクリーンアクティビティの分析です。これらの情報を元に、ユーザーが主に何をしていたかを簡潔に要約してください。要約は日本語で、3〜5文程度にまとめてください。

${screenAnalyses.join("\n\n---\n\n")}
`;

  // Call Gemini API for summarization
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" +
      GEMINI_API_KEY,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  return result.candidates[0].content.parts[0].text;
}

/**
 * Sends an activity summary to Obsidian
 * @param summary The summary text
 * @param startTime The start time of the summary period
 * @param endTime The end time of the summary period
 * @returns Whether the operation was successful
 */
async function sendSummaryToObsidian(
  summary: string,
  startTime: Date,
  endTime: Date
): Promise<boolean> {
  const OBSIDIAN_VAULT_NAME = Deno.env.get("OBSIDIAN_VAULT_NAME");

  if (!OBSIDIAN_VAULT_NAME) {
    console.warn(
      "OBSIDIAN_VAULT_NAME environment variable is not set. Skipping Obsidian integration."
    );
    return false;
  }

  try {
    // Format time range
    const startTimeStr = format(startTime, "HH:mm");
    const endTimeStr = format(endTime, "HH:mm");
    const timeRange = `${startTimeStr}〜${endTimeStr}`;

    // Prepare the summary text with header
    const summaryWithHeader = `## ${timeRange} アクティビティサマリー\n${summary}`;

    // Encode the summary for use in a URL
    const encodedSummary = encodeURIComponent(summaryWithHeader);

    // Create the Obsidian advanced-uri command
    const obsidianCommand = `open --background "obsidian://advanced-uri?vault=${OBSIDIAN_VAULT_NAME}&daily=true&mode=append&data=${encodedSummary}"`;

    console.log(obsidianCommand);

    // Execute the command
    const command = new Deno.Command("bash", {
      args: ["-c", obsidianCommand],
    });

    const { code } = await command.output();

    if (code !== 0) {
      console.error(`Failed to send summary to Obsidian, exit code: ${code}`);
      return false;
    }

    console.log("Activity summary sent to Obsidian successfully");
    return true;
  } catch (error) {
    console.error("Error sending summary to Obsidian:", error);
    return false;
  }
}

/**
 * Checks if it's time to generate a summary based on the last summary time
 * @returns Whether it's time to generate a summary
 */
async function isTimeForSummary(): Promise<boolean> {
  try {
    // Path to store the last summary time
    const lastSummaryPath = join(LOGS_DIR, "last_summary_time.txt");

    // Get current time
    const currentTime = new Date();

    // If the file doesn't exist, it's the first run
    if (!(await exists(lastSummaryPath))) {
      // Create the file with current time
      await Deno.writeTextFile(lastSummaryPath, currentTime.toISOString());
      return false; // Don't generate summary on first run
    }

    // Read the last summary time
    const lastSummaryTimeStr = await Deno.readTextFile(lastSummaryPath);
    const lastSummaryTime = new Date(lastSummaryTimeStr);

    // Calculate time difference in minutes
    const timeDiffMinutes =
      (currentTime.getTime() - lastSummaryTime.getTime()) / (1000 * 60);

    // Check if enough time has passed
    if (timeDiffMinutes >= SUMMARY_INTERVAL_MINUTES) {
      // Update the last summary time
      await Deno.writeTextFile(lastSummaryPath, currentTime.toISOString());
      return true;
    }

    return false;
  } catch (error) {
    console.error("Error checking summary time:", error);
    return false;
  }
}

/**
 * Generates and sends a summary of recent activities
 */
async function generateAndSendSummary(): Promise<void> {
  try {
    console.log("Checking if it's time for a summary...");

    // Check if it's time to generate a summary
    const shouldGenerateSummary = await isTimeForSummary();

    if (!shouldGenerateSummary) {
      console.log("Not time for a summary yet.");
      return;
    }

    console.log(
      `Generating summary for the past ${SUMMARY_INTERVAL_MINUTES} minutes...`
    );

    // Calculate time range
    const endTime = new Date();
    const startTime = new Date(endTime);
    startTime.setMinutes(startTime.getMinutes() - SUMMARY_INTERVAL_MINUTES);

    // Get activities in the time range
    const activities = await getActivitiesInTimeRange(startTime, endTime);

    if (activities.length === 0) {
      console.log("No activities found in the time range.");
      return;
    }

    console.log(`Found ${activities.length} activities in the time range.`);

    // Generate summary
    const summary = await generateActivitySummary(activities);
    console.log("Generated summary:", summary);

    // Send to Obsidian
    await sendSummaryToObsidian(summary, startTime, endTime);

    console.log("Summary generation and sending completed successfully");
  } catch (error) {
    console.error("Error generating or sending summary:", error);
  }
}

/**
 * Compares previous and current activities to determine if the user is continuing the same task
 * @param previousActivity The previous activity log entry
 * @param currentApps List of currently open applications
 * @returns Object containing continuity information
 */
function analyzeActivityContinuity(
  previousActivity: any,
  currentApps: Array<{ name: string; title?: string; isFrontmost: boolean }>
): {
  isContinuing: boolean;
  commonApps: string[];
  frontmostChanged: boolean;
  timeSinceLastActivity: string;
} {
  if (!previousActivity) {
    return {
      isContinuing: false,
      commonApps: [],
      frontmostChanged: true,
      timeSinceLastActivity: "N/A",
    };
  }

  // Get previous apps and frontmost app
  const previousApps = previousActivity.openApplications;
  const previousFrontmost = previousApps.find(
    (app: any) => app.isFrontmost
  )?.name;
  const currentFrontmost = currentApps.find((app) => app.isFrontmost)?.name;

  // Find common apps
  const previousAppNames = previousApps.map((app: any) => app.name);
  const currentAppNames = currentApps.map((app) => app.name);
  const commonApps = previousAppNames.filter((name: string) =>
    currentAppNames.includes(name)
  );

  // Calculate time since last activity
  const previousTime = new Date(previousActivity.timestamp);
  const currentTime = new Date();
  const timeDiffMs = currentTime.getTime() - previousTime.getTime();
  const timeDiffMinutes = Math.floor(timeDiffMs / (1000 * 60));
  let timeSinceLastActivity = "";

  if (timeDiffMinutes < 60) {
    timeSinceLastActivity = `${timeDiffMinutes} 分前`;
  } else {
    const hours = Math.floor(timeDiffMinutes / 60);
    const minutes = timeDiffMinutes % 60;
    timeSinceLastActivity = `${hours} 時間 ${minutes} 分前`;
  }

  // Determine if user is likely continuing the same task
  // Consider it continuing if:
  // 1. At least 70% of previous apps are still open
  // 2. Time difference is less than 2 hours
  const appContinuityRatio = commonApps.length / previousApps.length;
  const isContinuing =
    appContinuityRatio >= 0.7 && timeDiffMs < 2 * 60 * 60 * 1000;

  return {
    isContinuing,
    commonApps,
    frontmostChanged: previousFrontmost !== currentFrontmost,
    timeSinceLastActivity,
  };
}

/**
 * Analyzes a screenshot using Gemini Flash API
 * @param imagePath Path to the screenshot image
 * @param apps List of open applications
 * @param continuityInfo Information about activity continuity
 * @returns Analysis result from Gemini
 */
async function analyzeScreenshot(
  imagePath: string,
  apps: Array<{ name: string; title?: string; isFrontmost: boolean }>,
  continuityInfo?: {
    isContinuing: boolean;
    commonApps: string[];
    frontmostChanged: boolean;
    timeSinceLastActivity: string;
  }
): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY environment variable is not set");
  }

  // Optimize the image before sending to API
  const optimizedImagePath = await optimizeImage(imagePath);
  const imageData = await Deno.readFile(optimizedImagePath);

  // Convert binary data to base64 in chunks to avoid stack overflow
  const bytes = new Uint8Array(imageData);
  let binary = "";
  const chunkSize = 1024;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.slice(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }

  const base64Image = btoa(binary);

  // Create a prompt that includes the list of open applications
  const appsList = apps
    .map((app) => {
      if (app.title) {
        return `${app.name} (${app.title})${
          app.isFrontmost ? " (frontmost)" : ""
        }`;
      }
      return `${app.name}${app.isFrontmost ? " (frontmost)" : ""}`;
    })
    .join(", ");

  // Add continuity information to the prompt if available
  let continuityPrompt = "";
  if (continuityInfo) {
    if (continuityInfo.isContinuing) {
      continuityPrompt = `
ユーザーは${
        continuityInfo.timeSinceLastActivity
      }前のアクティビティを継続している可能性が高いです。
前回と共通のアプリケーション: ${continuityInfo.commonApps.join(", ")}
フォーカスしているアプリケーションの変更: ${
        continuityInfo.frontmostChanged ? "あり" : "なし"
      }
`;
    } else {
      continuityPrompt = `
ユーザーは${continuityInfo.timeSinceLastActivity}前のアクティビティから新しいタスクに移行した可能性があります。
`;
    }
  }

  const prompt = `
スクリーンショットと現在開いているアプリケーションのリスト (${appsList})、特に表示されているコンテンツについて触れながら、ユーザーが何をしているか日本語で簡潔に分析してください。表示されていないコンテンツや、不適切なコンテンツは除外してください。
${continuityPrompt}
`;

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" +
      GEMINI_API_KEY,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
              {
                inline_data: {
                  mime_type: "image/png",
                  data: base64Image,
                },
              },
            ],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  return result.candidates[0].content.parts[0].text;
}

/**
 * Logs the screen activity information
 * @param screenshotPath Path to the screenshot
 * @param optimizedScreenshotPath Path to the optimized screenshot (if available)
 * @param apps List of open applications
 * @param analysis Gemini's analysis of the screenshot
 */
async function logActivity(
  screenshotPath: string,
  optimizedScreenshotPath: string | null,
  apps: Array<{ name: string; title?: string; isFrontmost: boolean }>,
  analysis: string
): Promise<void> {
  const timestamp = new Date().toISOString();
  const logFilename = `activity_${timestamp.split("T")[0]}.log`;
  const logPath = join(LOGS_DIR, logFilename);

  const logEntry = {
    timestamp,
    screenshot: screenshotPath,
    optimizedScreenshot: optimizedScreenshotPath || undefined,
    openApplications: apps,
    screenAnalysis: analysis,
  };

  const logContent = JSON.stringify(logEntry, null, 2);

  await Deno.writeTextFile(logPath, logContent + "\n", { append: true });
  console.log(`Activity logged to ${logPath}`);
}

/**
 * Sends the screen analysis to Obsidian using the advanced-uri protocol
 * @param analysis Gemini's analysis of the screenshot
 * @returns Whether the operation was successful
 */
async function sendToObsidian(analysis: string): Promise<boolean> {
  const OBSIDIAN_VAULT_NAME = Deno.env.get("OBSIDIAN_VAULT_NAME");

  if (!OBSIDIAN_VAULT_NAME) {
    console.warn(
      "OBSIDIAN_VAULT_NAME environment variable is not set. Skipping Obsidian integration."
    );
    return false;
  }

  try {
    // Format current time as HH:MM
    const now = new Date();
    const currentTime = format(now, "HH:mm");

    // Prepare the memo text (the analysis)
    // Encode the analysis for use in a URL
    const encodedAnalysis = encodeURIComponent(analysis);

    // Create the Obsidian advanced-uri command
    const obsidianCommand = `open --background "obsidian://advanced-uri?vault=${OBSIDIAN_VAULT_NAME}&daily=true&mode=append&data=%23%23%23%20${currentTime}%0D%0A${encodedAnalysis}"`;

    console.log(obsidianCommand);

    // Execute the command
    const command = new Deno.Command("bash", {
      args: ["-c", obsidianCommand],
    });

    const { code } = await command.output();

    if (code !== 0) {
      console.error(`Failed to send to Obsidian, exit code: ${code}`);
      return false;
    }

    console.log("Screen analysis sent to Obsidian successfully");
    return true;
  } catch (error) {
    console.error("Error sending to Obsidian:", error);
    return false;
  }
}

/**
 * Main function to capture and analyze screen activity
 */
async function captureScreenActivity(): Promise<void> {
  try {
    console.log("Starting screen activity capture...");

    // Check if user is AFK
    const afk = await isUserAFK();
    if (afk) {
      console.log(
        `User is AFK (idle for ≥${AFK_TIMEOUT_MINUTES} minutes). Skipping screen interpretation.`
      );
      return;
    }

    console.log("User is active. Proceeding with screen interpretation...");

    // Get the most recent activity
    const recentActivity = await getRecentActivity();

    // Take screenshot
    const screenshotPath = await takeScreenshot();

    // Get open applications
    const openApps = await getOpenApplications();
    console.log("Open applications:", openApps);

    // Analyze continuity with previous activity
    const continuityInfo = recentActivity
      ? analyzeActivityContinuity(recentActivity, openApps)
      : undefined;

    if (continuityInfo) {
      console.log("Activity continuity analysis:", continuityInfo);
    }

    // Optimize the screenshot for analysis
    const optimizedScreenshotPath = await optimizeImage(screenshotPath);

    // Analyze screenshot with Gemini, including continuity information
    const analysis = await analyzeScreenshot(
      screenshotPath,
      openApps,
      continuityInfo
    );
    console.log("Screen analysis:", analysis);

    // Log the activity
    await logActivity(
      screenshotPath,
      optimizedScreenshotPath,
      openApps,
      analysis
    );

    // Send the analysis to Obsidian
    await sendToObsidian(analysis);

    // Check if it's time to generate a summary and send it
    await generateAndSendSummary();

    console.log("Screen activity capture completed successfully");
  } catch (error) {
    console.error("Error capturing screen activity:", error);
  }
}

// Run the main function
if (import.meta.main) {
  await captureScreenActivity();
}

export { captureScreenActivity };
