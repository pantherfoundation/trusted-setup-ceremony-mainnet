import * as fs from "fs-extra";
import * as path from "path";
import { execSync } from "child_process";
import dotenv from "dotenv";
import { S3_CONTRIBUTION_DIR } from "./constants";

// Load environment variables from .env file - this works in local dev but may not in Docker
dotenv.config();

// Function to check required environment variables
export function checkRequiredEnvVars(): void {
  const requiredVars = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_DEFAULT_REGION",
    "AWS_ENDPOINT_URL",
    "S3BUCKET",
  ];

  const missingVars = requiredVars.filter((varName) => !process.env[varName]);

  if (missingVars.length > 0) {
    console.error(
      `❌ Error: Missing required environment variables: ${missingVars.join(", ")}`,
    );
    console.error(
      "Please make sure you have created a .env file with these variables or set them in your environment.",
    );
    console.error(
      "In Docker, use: docker run --env-file .env ... or mount the .env file and set --volume flag.",
    );

    // If we're likely running in Docker, provide a more specific suggestion
    if (fs.existsSync("/.dockerenv") || process.env.DOCKER_CONTAINER) {
      console.error("\nDocker-specific suggestions:");
      console.error(
        "1. Make sure you are using --env-file .env in your docker run command",
      );
      console.error(
        "2. Try using individual -e flags: -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY ...",
      );
      console.error(
        "3. Check that your .env file is in the current directory where you run docker command",
      );
    }

    process.exit(1);
  }
}

export const contributionRootFolder = "./contributions";

// Get S3 configuration from environment variables
const S3_BUCKET_PATH = process.env.S3BUCKET!;
export const S3_BUCKET_NAME = S3_BUCKET_PATH.replace("s3://", "");
export const AWS_REGION = process.env.AWS_DEFAULT_REGION!;
export const AWS_ENDPOINT = process.env.AWS_ENDPOINT_URL!;

// Use environment variables for AWS credentials
const AWS_ENV_VARS = {
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_DEFAULT_REGION: AWS_REGION,
  AWS_ENDPOINT_URL: AWS_ENDPOINT,
};

export function getDirectories(source: string): string[] {
  return fs
    .readdirSync(source, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);
}

export function getZkeyFiles(directory: string): string[] {
  const zkFilesFolder = path.join(contributionRootFolder, directory);
  return fs.readdirSync(zkFilesFolder).filter((file) => file.endsWith(".zkey"));
}

export function getContributionFolders(): string[] {
  const folders = getDirectories(contributionRootFolder);
  const contributionFolders = folders.filter((f) => f.match(/^\d{4}_/));
  contributionFolders.sort();
  return contributionFolders;
}

export function getCircuitR1cs(initialFolder: string): string {
  const folder = path.join(contributionRootFolder, initialFolder);
  const r1csFiles = fs
    .readdirSync(folder)
    .filter((file) => file.endsWith(".r1cs"));

  if (r1csFiles.length === 0) {
    throw new Error(`No .r1cs files found in ${initialFolder}`);
  }

  return path.join(initialFolder, r1csFiles[0]);
}

// Check if AWS CLI is available
export function isAwsCliAvailable(): boolean {
  try {
    execSync("aws --version", { stdio: "ignore" });
    return true;
  } catch (error) {
    return false;
  }
}

// Run AWS CLI commands with environment variables
function runAwsCommand(
  command: string,
  stdio: "inherit" | "pipe" | "ignore" = "inherit",
): string {
  if (!isAwsCliAvailable()) {
    console.warn(
      "AWS CLI not available or not compatible with current environment.",
    );
    if (command.includes("s3 cp") && command.includes("--recursive")) {
      throw new Error(
        "AWS CLI not available or not compatible with current environment.",
      );
    }
    return "";
  }

  const envVars = { ...process.env, ...AWS_ENV_VARS };

  try {
    console.log(`Runing: ${command}`);
    return execSync(command, { env: envVars, stdio, encoding: "utf8" });
  } catch (error) {
    if (stdio === "ignore") {
      return "";
    }
    console.warn(`Command failed: ${command}`);
    console.warn(
      "This may be due to architecture compatibility issues in Docker.",
    );
    return "";
  }
}

// S3 functions for downloading and uploading files
export function downloadFromS3(prefix?: string): boolean {
  try {
    const s3Path = asS3Path(prefix || "/");
    const localPath = prefix
      ? path.join(contributionRootFolder, prefix)
      : contributionRootFolder;

    // Ensure the local directory exists
    fs.ensureDirSync(localPath);

    if (!isAwsCliAvailable()) {
      console.warn("AWS CLI not available. Skipping S3 download.");
      return false;
    }

    console.log(`Downloading files from ${s3Path} to ${localPath}...`);
    const result = runAwsCommand(
      `aws s3 cp ${s3Path} ${localPath} --recursive`,
    );

    if (result !== "") {
      console.log("Download complete!");
      return true;
    } else {
      console.warn(
        "S3 download was not successful. Proceeding with local files only.",
      );
      return false;
    }
  } catch (error) {
    console.error("Error downloading files from S3:", error);
    console.warn("Proceeding with local files only.");
    return false;
  }
}

export function uploadToS3(folderName: string): boolean {
  try {
    if (!isAwsCliAvailable()) {
      console.warn("AWS CLI not available. Skipping S3 upload.");
      return false;
    }

    const localPath = path.join(contributionRootFolder, folderName);
    const s3Path = asS3Path(folderName);

    console.log(`Uploading files from ${localPath} to ${s3Path}...`);
    const result = runAwsCommand(
      `aws s3 cp ${localPath} ${s3Path} --recursive`,
    );

    if (result !== "") {
      console.log("Upload complete!");
      return true;
    } else {
      console.warn("S3 upload was not successful.");
      return false;
    }
  } catch (error) {
    console.error("Error uploading files to S3:", error);
    return false;
  }
}

// Function to download the latest contribution folder
export function downloadLatestContribution(): string | null {
  try {
    if (!isAwsCliAvailable()) {
      console.warn("AWS CLI not available. Skipping S3 download check.");
      return null;
    }

    // List folders in S3 bucket and get the latest contribution folder
    const output = runAwsCommand(
      `aws s3 ls ${asS3Path("/")} | grep -o "[0-9]\\{4\\}_[^/]*/" | sort | tail -1`,
      "pipe",
    );

    if (!output) {
      console.log(
        "No contribution folders found in S3 bucket or S3 access failed.",
      );
      return null;
    }

    // Remove trailing slash
    const folderName = output.trim().replace(/\/$/, "");
    console.log(`Latest contribution folder in S3: ${folderName}`);

    // Check if the folder already exists locally
    const localPath = path.join(contributionRootFolder, folderName);

    // Function to check if a folder has the required zkey files
    function hasRequiredZkeyFiles(folderPath: string): boolean {
      try {
        const zkeyFiles = getZkeyFiles(path.basename(folderPath));
        return zkeyFiles.length > 0;
      } catch (error) {
        return false;
      }
    }

    // Check if the folder exists and has at least some zkey files
    if (
      fs.existsSync(localPath) &&
      fs.readdirSync(localPath).length > 0 &&
      hasRequiredZkeyFiles(localPath)
    ) {
      console.log(
        `Folder ${folderName} already exists locally with required zkey files. Skipping download.`,
      );

      // Even if folder exists, we should cross-check to make sure all files are present
      // crossCheckFilesWithS3(folderName);
    } else {
      // Download the folder if it doesn't exist locally or doesn't have required files
      console.log(
        `Folder ${folderName} doesn't exist locally or is missing required zkey files. Downloading...`,
      );
      const success = downloadFromS3(folderName);
      if (!success) {
        console.warn(
          `Could not download ${folderName} from S3. Will proceed with local files only.`,
        );
      } else {
        // Verify the downloaded folder has the required zkey files
        if (!hasRequiredZkeyFiles(localPath)) {
          console.warn(
            `Downloaded folder ${folderName} is missing required zkey files.`,
          );
        }
      }
    }

    return folderName;
  } catch (error) {
    console.error("Error getting latest contribution from S3:", error);
    console.warn("Will proceed with local files only.");
    return null;
  }
}

// Download initial setup if not available locally
export function ensureInitialSetup(): void {
  const initialFolder = "0000_initial";
  const localPath = path.join(contributionRootFolder, initialFolder);

  // Create contributions root directory if it doesn't exist
  fs.ensureDirSync(contributionRootFolder);

  // Function to check if initial folder has required files
  function hasRequiredInitialFiles(): boolean {
    try {
      const zkeyFiles = getZkeyFiles(initialFolder);
      if (zkeyFiles.length === 0) {
        console.warn(`Initial folder is missing required .zkey files`);
        return false;
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  // Check if initial folder exists AND has required files
  if (!fs.existsSync(localPath) || !hasRequiredInitialFiles()) {
    console.log(
      `Initial setup folder not found locally or missing required files. Attempting to download from S3...`,
    );
    const success = downloadFromS3(initialFolder);

    if (!success || !hasRequiredInitialFiles()) {
      console.warn(`
⚠️  WARNING: Could not download initial setup from S3 or initial setup is missing required files.
If this is your first time running the tool, you need either:
1. A working AWS configuration to download the initial setup from S3
2. The initial setup files in ./contributions/0000_initial including .r1cs and .zkey files
`);
      throw new Error("Cannot proceed without proper initial setup");
    }
  } else {
    console.log(`Initial setup folder exists locally with required files.`);
    // Even if folder exists with basic required files, cross-check to ensure all files are present
    crossCheckFilesWithS3(initialFolder);
  }
}

// Check if files match between S3 and local directories
export function crossCheckFilesWithS3(folderName: string): boolean {
  if (!isAwsCliAvailable()) {
    console.warn("AWS CLI not available. Skipping S3 file cross-check.");
    return false;
  }

  try {
    console.log(
      `Cross-checking files between S3 and local for ${folderName}...`,
    );

    // Get list of files from S3
    const s3FilesOutput = runAwsCommand(
      `aws s3 ls ${asS3Path(folderName)} --recursive | awk '{print $4}' | sort`,
      "pipe",
    );

    if (!s3FilesOutput) {
      console.warn(`No files found in S3 for folder ${folderName}`);
      return false;
    }

    // Parse S3 files (remove the folder prefix from each file)
    const s3Files = s3FilesOutput
      .trim()
      .split("\n")
      .map((file) => file.replace(`${S3_CONTRIBUTION_DIR}/${folderName}/`, ""))
      .filter(Boolean);

    // Get local files
    const localPath = path.join(contributionRootFolder, folderName);
    if (!fs.existsSync(localPath)) {
      console.warn(`Local folder ${folderName} does not exist`);
      return false;
    }

    const getFilesRecursively = (
      dir: string,
      baseDir: string = dir,
    ): string[] => {
      let results: string[] = [];
      const files = fs.readdirSync(dir);

      files.forEach((file) => {
        const fullPath = path.join(dir, file);
        const relativePath = path.relative(baseDir, fullPath);

        if (fs.statSync(fullPath).isDirectory()) {
          results = results.concat(getFilesRecursively(fullPath, baseDir));
        } else {
          results.push(relativePath);
        }
      });

      return results;
    };

    const localFiles = getFilesRecursively(localPath).sort();

    // List of OS-specific files to ignore
    const ignoreFiles = [".DS_Store", "Thumbs.db", ".directory", "._*"];

    // Function to check if a file should be ignored
    function shouldIgnoreFile(file: string): boolean {
      return ignoreFiles.some((pattern) => {
        if (pattern.endsWith("*")) {
          return file.startsWith(pattern.slice(0, -1));
        }
        return file === pattern;
      });
    }

    // Filter out ignored files from both lists
    const filteredS3Files = s3Files.filter((file) => !shouldIgnoreFile(file));
    const filteredLocalFiles = localFiles.filter(
      (file) => !shouldIgnoreFile(file),
    );

    // Find missing files (ignoring OS-specific files)
    const missingLocalFiles = filteredS3Files.filter(
      (file) => !filteredLocalFiles.includes(file),
    );
    const missingS3Files = filteredLocalFiles.filter(
      (file) => !filteredS3Files.includes(file),
    );

    if (missingLocalFiles.length > 0) {
      console.warn(
        `Missing ${missingLocalFiles.length} files locally that exist in S3 for ${folderName}:`,
      );
      missingLocalFiles.forEach((file) => console.warn(`  - ${file}`));

      // Download missing files
      const shouldDownload = missingLocalFiles.some(
        (file) => file.endsWith(".zkey") || file.endsWith(".r1cs"),
      );
      if (shouldDownload) {
        console.log(
          `Attempting to download missing files for ${folderName}...`,
        );

        // Create directory if it doesn't exist
        fs.ensureDirSync(localPath);

        // Download each missing file
        let downloadedCount = 0;
        for (const file of missingLocalFiles) {
          const s3Path = `${S3_BUCKET_PATH}/${folderName}/${file}`;
          const localFilePath = path.join(localPath, file);

          // Make sure the directory for the file exists
          fs.ensureDirSync(path.dirname(localFilePath));

          console.log(`Downloading ${file}...`);
          const downloadCmd = `aws s3 cp ${s3Path} ${localFilePath}`;
          try {
            runAwsCommand(downloadCmd);
            downloadedCount++;
          } catch (error) {
            console.error(`Failed to download ${file}: ${error}`);
          }
        }

        console.log(
          `Downloaded ${downloadedCount}/${missingLocalFiles.length} missing files.`,
        );
      }
    }

    // Report missing S3 files (ignoring OS-specific files)
    if (missingS3Files.length > 0) {
      console.log(
        `${missingS3Files.length} files exist locally but not in S3 for ${folderName} (OS-specific files ignored)`,
      );
    }

    // Special check for zkey files
    const s3ZkeyFiles = filteredS3Files.filter((file) =>
      file.endsWith(".zkey"),
    );
    const localZkeyFiles = filteredLocalFiles.filter((file) =>
      file.endsWith(".zkey"),
    );

    if (s3ZkeyFiles.length > localZkeyFiles.length) {
      console.warn(
        `Missing ${s3ZkeyFiles.length - localZkeyFiles.length} zkey files locally`,
      );
    } else if (
      localZkeyFiles.length === s3ZkeyFiles.length &&
      missingLocalFiles.some((file) => file.endsWith(".zkey"))
    ) {
      console.log(`All zkey files are now available locally.`);
    }

    // Re-check after download
    if (missingLocalFiles.length > 0) {
      const newLocalFiles = getFilesRecursively(localPath)
        .filter((file) => !shouldIgnoreFile(file))
        .sort();

      const stillMissing = filteredS3Files.filter(
        (file) => !newLocalFiles.includes(file),
      );

      if (stillMissing.length > 0) {
        console.warn(
          `Still missing ${stillMissing.length} files after download attempt.`,
        );
        return false;
      } else {
        console.log(`All required files are now present locally.`);
        return true;
      }
    }

    return missingLocalFiles.length === 0;
  } catch (error) {
    console.error("Error cross-checking files with S3:", error);
    return false;
  }
}

// Function to ensure the PTAU file is available
export function ensurePtauFile(): string {
  const ptauFileName = "powersOfTau28_hez_final_18.ptau";
  const ptauLocalPath = path.join(contributionRootFolder, ptauFileName);

  // Check if PTAU file exists locally
  if (!fs.existsSync(ptauLocalPath)) {
    console.log(`PTAU file not found locally. Downloading from S3...`);
    try {
      // Ensure the directory exists
      fs.ensureDirSync(contributionRootFolder);

      // Use runAwsCommand for consistency
      runAwsCommand(
        `aws s3 cp ${S3_BUCKET_PATH}/${ptauFileName} ${ptauLocalPath}`,
      );
      console.log(`✅ PTAU file downloaded successfully!`);
    } catch (error) {
      console.error(`❌ Failed to download PTAU file`);
      if (error instanceof Error) {
        console.error(error.message);
      }
      throw new Error("Failed to download required PTAU file");
    }
  } else {
    console.log(`Using existing PTAU file at ${ptauLocalPath}`);
  }

  return ptauLocalPath;
}

// Add function to get the r1cs folder path
export function getR1csFolderPath(): string {
  return path.join(process.cwd(), "r1cs");
}

// Function to ensure r1cs files are available
export function ensureR1csFiles(): string {
  const r1csFolder = "r1cs";
  const r1csFolderPath = path.join(contributionRootFolder, r1csFolder);

  // Create r1cs directory if it doesn't exist
  fs.ensureDirSync(r1csFolderPath);

  // Function to check if r1cs folder has required files
  function hasRequiredR1csFiles(): boolean {
    try {
      const r1csFiles = fs
        .readdirSync(r1csFolderPath)
        .filter((file) => file.endsWith(".r1cs"));
      if (r1csFiles.length === 0) {
        console.warn(`R1CS folder is missing required .r1cs files`);
        return false;
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  // Check if r1cs folder exists AND has required files
  if (!fs.existsSync(r1csFolderPath) || !hasRequiredR1csFiles()) {
    console.log(
      `R1CS files not found locally or missing required files. Attempting to download from S3...`,
    );

    if (!isAwsCliAvailable()) {
      console.warn("AWS CLI not available. Skipping S3 download.");
      throw new Error(
        "Cannot proceed without r1cs files and AWS CLI is not available",
      );
    }

    const s3R1csPath = asS3Path(r1csFolder);

    try {
      console.log(
        `Downloading r1cs files from ${s3R1csPath} to ${r1csFolderPath}...`,
      );
      const result = runAwsCommand(
        `aws s3 cp ${s3R1csPath} ${r1csFolderPath} --recursive`,
      );

      if (result === "") {
        console.warn(`Failed to download r1cs files from S3`);
        throw new Error("Cannot proceed without r1cs files");
      }
    } catch (error) {
      console.error(`Error downloading r1cs files from S3: ${error}`);
      throw new Error("Cannot proceed without r1cs files");
    }

    // Verify that r1cs files were successfully downloaded
    if (!hasRequiredR1csFiles()) {
      throw new Error(
        "R1CS files download seemed to succeed but required files are still missing",
      );
    }

    console.log(`✅ R1CS files downloaded successfully`);
  } else {
    console.log(`R1CS files already exist locally with required files.`);
  }

  // Cross-check r1cs files with S3
  // crossCheckR1csFilesWithS3();

  return r1csFolderPath;
}

// Function to cross-check r1cs files with S3
function crossCheckR1csFilesWithS3(): boolean {
  if (!isAwsCliAvailable()) {
    console.warn(
      "AWS CLI not available. Skipping r1cs files cross-check with S3.",
    );
    return false;
  }

  const r1csFolder = "r1cs";
  const r1csFolderPath = path.join(contributionRootFolder, r1csFolder);

  try {
    console.log(`Cross-checking r1cs files between S3 and local...`);

    // Get list of r1cs files from S3
    const s3FilesOutput = runAwsCommand(
      `aws s3 ls ${asS3Path(r1csFolder)} --recursive | awk '{print $4}' | sort`,
      "pipe",
    );

    if (!s3FilesOutput) {
      console.warn(`No r1cs files found in S3`);
      return false;
    }

    // Parse S3 files (remove the folder prefix from each file)
    const s3Files = s3FilesOutput
      .trim()
      .split("\n")
      .map((file) => file.replace(`${S3_CONTRIBUTION_DIR}/${r1csFolder}/`, ""))
      .filter(Boolean);

    // Get local files
    if (!fs.existsSync(r1csFolderPath)) {
      console.warn(`Local r1cs folder does not exist`);
      return false;
    }

    const getFilesRecursively = (
      dir: string,
      baseDir: string = dir,
    ): string[] => {
      let results: string[] = [];
      const files = fs.readdirSync(dir);

      files.forEach((file) => {
        const fullPath = path.join(dir, file);
        const relativePath = path.relative(baseDir, fullPath);

        if (fs.statSync(fullPath).isDirectory()) {
          results = results.concat(getFilesRecursively(fullPath, baseDir));
        } else {
          results.push(relativePath);
        }
      });

      return results;
    };

    const localFiles = getFilesRecursively(r1csFolderPath).sort();

    // List of OS-specific files to ignore
    const ignoreFiles = [".DS_Store", "Thumbs.db", ".directory", "._*"];

    // Function to check if a file should be ignored
    function shouldIgnoreFile(file: string): boolean {
      return ignoreFiles.some((pattern) => {
        if (pattern.endsWith("*")) {
          return file.startsWith(pattern.slice(0, -1));
        }
        return file === pattern;
      });
    }

    // Filter out ignored files from both lists
    const filteredS3Files = s3Files.filter((file) => !shouldIgnoreFile(file));
    const filteredLocalFiles = localFiles.filter(
      (file) => !shouldIgnoreFile(file),
    );

    // Find missing files (ignoring OS-specific files)
    const missingLocalFiles = filteredS3Files.filter(
      (file) => !filteredLocalFiles.includes(file),
    );
    const missingS3Files = filteredLocalFiles.filter(
      (file) => !filteredS3Files.includes(file),
    );

    if (missingLocalFiles.length > 0) {
      console.warn(
        `Missing ${missingLocalFiles.length} r1cs files locally that exist in S3:`,
      );
      missingLocalFiles.forEach((file) => console.warn(`  - ${file}`));

      // Download missing files
      const shouldDownload = missingLocalFiles.some((file) =>
        file.endsWith(".r1cs"),
      );
      if (shouldDownload) {
        console.log(`Attempting to download missing r1cs files...`);

        // Create directory if it doesn't exist
        fs.ensureDirSync(r1csFolderPath);

        // Download each missing file
        let downloadedCount = 0;
        for (const file of missingLocalFiles) {
          const s3Path = `${S3_BUCKET_PATH}/${r1csFolder}/${file}`;
          const localFilePath = path.join(r1csFolderPath, file);

          // Make sure the directory for the file exists
          fs.ensureDirSync(path.dirname(localFilePath));

          console.log(`Downloading ${file}...`);
          const downloadCmd = `aws s3 cp ${s3Path} ${localFilePath}`;
          try {
            runAwsCommand(downloadCmd);
            downloadedCount++;
          } catch (error) {
            console.error(`Failed to download ${file}: ${error}`);
          }
        }

        console.log(
          `Downloaded ${downloadedCount}/${missingLocalFiles.length} missing r1cs files.`,
        );
      }
    }

    // Report missing S3 files (ignoring OS-specific files)
    if (missingS3Files.length > 0) {
      console.log(
        `${missingS3Files.length} r1cs files exist locally but not in S3 (OS-specific files ignored)`,
      );
    }

    // Special check for r1cs files
    const s3R1csFiles = filteredS3Files.filter((file) =>
      file.endsWith(".r1cs"),
    );
    const localR1csFiles = filteredLocalFiles.filter((file) =>
      file.endsWith(".r1cs"),
    );

    if (s3R1csFiles.length > localR1csFiles.length) {
      console.warn(
        `Missing ${s3R1csFiles.length - localR1csFiles.length} r1cs files locally`,
      );
    } else if (
      localR1csFiles.length === s3R1csFiles.length &&
      missingLocalFiles.some((file) => file.endsWith(".r1cs"))
    ) {
      console.log(`All r1cs files are now available locally.`);
    }

    // Re-check after download
    if (missingLocalFiles.length > 0) {
      const newLocalFiles = getFilesRecursively(r1csFolderPath)
        .filter((file) => !shouldIgnoreFile(file))
        .sort();

      const stillMissing = filteredS3Files.filter(
        (file) => !newLocalFiles.includes(file),
      );

      if (stillMissing.length > 0) {
        console.warn(
          `Still missing ${stillMissing.length} r1cs files after download attempt.`,
        );
        return false;
      } else {
        console.log(`All required r1cs files are now present locally.`);
        return true;
      }
    }

    return missingLocalFiles.length === 0;
  } catch (error) {
    console.error("Error cross-checking r1cs files with S3:", error);
    return false;
  }
}

export function asS3Path(value: string): string {
  const subPath = path.join(S3_CONTRIBUTION_DIR, value);
  return `s3://${S3_BUCKET_NAME}/${subPath}`;
}
