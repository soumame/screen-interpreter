import { ensureDir } from "std/fs";
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

// Ensure directories exist
await ensureDir(SCREENSHOTS_DIR);
await ensureDir(LOGS_DIR);

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
 * Analyzes a screenshot using Gemini Flash API
 * @param imagePath Path to the screenshot image
 * @param apps List of open applications
 * @returns Analysis result from Gemini
 */
async function analyzeScreenshot(
  imagePath: string,
  apps: Array<{ name: string; title?: string; isFrontmost: boolean }>
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

  const prompt = `
スクリーンショットと現在開いているアプリケーションのリスト (${appsList})、特に表示されているコンテンツについて触れながら、ユーザーが何をしているか日本語で簡潔に分析してください。表示されていないコンテンツや、不適切なコンテンツは除外してください。
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
    const obsidianCommand = `open --background "obsidian://advanced-uri?vault=${OBSIDIAN_VAULT_NAME}&daily=true&mode=append&data=%23%23%20${currentTime}%0D%0A${encodedAnalysis}"`;

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

    // Take screenshot
    const screenshotPath = await takeScreenshot();

    // Get open applications
    const openApps = await getOpenApplications();
    console.log("Open applications:", openApps);

    // Optimize the screenshot for analysis
    const optimizedScreenshotPath = await optimizeImage(screenshotPath);

    // Analyze screenshot with Gemini
    const analysis = await analyzeScreenshot(screenshotPath, openApps);
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
