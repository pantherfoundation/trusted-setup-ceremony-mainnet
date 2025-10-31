import * as fs from "fs-extra";
import { execSync } from "child_process";
import * as readlineSync from "readline-sync";
import * as path from "path";
import * as crypto from "crypto";
import {
  contributionRootFolder,
  getContributionFolders,
  getZkeyFiles,
  downloadLatestContribution,
  ensureInitialSetup,
  uploadToS3,
  crossCheckFilesWithS3,
  checkRequiredEnvVars,
  isAwsCliAvailable,
} from "./utils";

interface ContributionConfig {
  contributionNumber: string;
  githubUsername: string;
  folderName: string;
  timestamp: string;
}

interface ZkeyContribution {
  filename: string;
  hash: string;
}

interface ContributionResult {
  config: ContributionConfig;
  contributions: ZkeyContribution[];
}

function generateSecureEntropy(): string {
  return crypto.randomBytes(128).toString("hex");
}

function generateSystemEntropy(): string {
  try {
    const systemEntropy = execSync(
      "LC_ALL=C tr -dc 'A-F0-9' < /dev/urandom | head -c32",
      {
        encoding: "utf8",
      },
    );
    console.log("System entropy added from /dev/urandom");
    return systemEntropy;
  } catch (error) {
    // First fallback using hexdump if available
    try {
      const systemEntropy = execSync(
        "head -c16 /dev/urandom | xxd -p | tr -d '\\n'",
        {
          encoding: "utf8",
        },
      );
      console.log("System entropy added using /dev/urandom and xxd");
      return systemEntropy;
    } catch (innerError) {
      console.log("Could not generate system entropy. Skipping.");
      return "";
    }
  }
}

function collectAdditionalEntropy(): string {
  if (
    readlineSync.keyInYN(
      "Would you like to add additional entropy by typing random keys?",
    )
  ) {
    const additionalEntropy = readlineSync.question(
      "Please mash your keyboard randomly (hidden input): ",
      {
        hideEchoBack: true,
      },
    );
    console.log("Additional entropy received");
    return additionalEntropy;
  }
  return "";
}

function setupContribution(): ContributionConfig {
  // Ensure the contributions folder exists
  fs.ensureDirSync(contributionRootFolder);

  const contributionFolders = getContributionFolders();

  let contributionNumber: string;

  if (contributionFolders.length === 0) {
    // First contribution case
    console.log("No contribution folders found locally. Checking S3...");
    const s3Folder = downloadLatestContribution();

    if (
      !s3Folder &&
      !fs.existsSync(path.join(contributionRootFolder, "0000_initial"))
    ) {
      throw new Error(
        "Initial setup folder '0000_initial' not found. Please ensure it exists with the initial circuit files.\n" +
          "This could be due to:\n" +
          "1. Missing AWS credentials - check your .env file or AWS CLI configuration\n" +
          "2. The initial setup hasn't been uploaded to S3 yet\n" +
          "3. The S3 bucket configuration is incorrect\n" +
          "Please refer to the README.md troubleshooting section for more information.",
      );
    }

    // Get the updated list of folders after potential S3 download
    const updatedFolders = getContributionFolders();
    if (updatedFolders.length === 0) {
      contributionNumber = "0001";
    } else {
      const lastFolder = updatedFolders[updatedFolders.length - 1];
      const lastContribution = parseInt(lastFolder.substring(0, 4));
      contributionNumber = (lastContribution + 1).toString().padStart(4, "0");
    }
  } else {
    const lastFolder = contributionFolders[contributionFolders.length - 1];
    const lastContribution = parseInt(lastFolder.substring(0, 4));
    contributionNumber = (lastContribution + 1).toString().padStart(4, "0");
  }

  const githubUsername = readlineSync.question("Enter your GitHub username: ");
  const folderName = `${contributionNumber}_${githubUsername}`;

  fs.mkdirSync(path.join(contributionRootFolder, folderName), {
    recursive: true,
  });

  return {
    contributionNumber,
    githubUsername,
    folderName,
    timestamp: new Date().toISOString(),
  };
}

function contributeToZkey(
  zkeyFile: string,
  lastFolder: string,
  config: ContributionConfig,
  baseEntropy: string,
): ZkeyContribution {
  console.log(`\nProcessing ${zkeyFile}...`);

  const latestZkey = path.join(contributionRootFolder, lastFolder, zkeyFile);
  const newZkey = path.join(
    contributionRootFolder,
    config.folderName,
    zkeyFile,
  );

  console.log(`Contributing to ${zkeyFile}...`);
  const contributionName = `Contribution #${config.contributionNumber} from ${config.githubUsername}`;

  const uniqueEntropy = crypto
    .createHash("sha512")
    .update(baseEntropy, "utf8")
    .digest("hex");
  const command = `echo ${uniqueEntropy} | snarkjs zkey contribute -v ${latestZkey} ${newZkey} --name="${contributionName}"`;

  console.log(
    `Executing contribution command (not showing entropy for security)...`,
  );
  execSync(command, { stdio: "inherit" });

  const vkeyName = zkeyFile.replace(".zkey", "_verification_key.json");
  const vkey = path.join(contributionRootFolder, config.folderName, vkeyName);
  execSync(`snarkjs zkey export verificationkey ${newZkey} ${vkey}`, {
    stdio: "inherit",
  });

  const transcriptPath = path.join(
    contributionRootFolder,
    config.folderName,
    `${zkeyFile}_transcript.txt`,
  );
  fs.writeFileSync(
    transcriptPath,
    `Contribution to ${zkeyFile} by ${config.githubUsername}\nTimestamp: ${config.timestamp}\n`,
  );

  console.log(`✅ Contribution to ${zkeyFile} complete!`);

  const hash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(newZkey))
    .digest("hex");

  return {
    filename: zkeyFile,
    hash,
  };
}

function createMetadataFiles(
  config: ContributionConfig,
  contributions: ZkeyContribution[],
): void {
  fs.writeFileSync(
    path.join(contributionRootFolder, config.folderName, "contribution.txt"),
    `Contribution by ${config.githubUsername}\nTimestamp: ${config.timestamp}\n\nEntropy was generated using a secure method and has been deleted.`,
  );

  console.log("\nGenerating attestation file...");
  const attestationPath = path.join(
    contributionRootFolder,
    config.folderName,
    "attestation.json",
  );

  const attestationData = {
    contributor: config.githubUsername,
    contributionNumber: config.contributionNumber,
    timestamp: config.timestamp,
    files: contributions,
  };

  fs.writeFileSync(attestationPath, JSON.stringify(attestationData, null, 2));

  console.log(`✅ Attestation generated at ${attestationPath}`);
}

function performContributions(
  config: ContributionConfig,
  lastFolder: string,
): ZkeyContribution[] {
  const zkeyFiles = getZkeyFiles(lastFolder);

  if (zkeyFiles.length === 0) {
    throw new Error(`No .zkey files found in ${lastFolder}`);
  }

  console.log(`Found ${zkeyFiles.length} zkey files to contribute to.`);

  const systemEntropy = generateSystemEntropy();
  const additionalEntropy = collectAdditionalEntropy();
  const mainEntropy = generateSecureEntropy();
  const baseEntropy = mainEntropy + additionalEntropy + systemEntropy;
  console.log("Secure entropy generated (not displayed for security)");

  return zkeyFiles.map((zkeyFile) => {
    const fileSpecificEntropy = baseEntropy + zkeyFile;
    return contributeToZkey(zkeyFile, lastFolder, config, fileSpecificEntropy);
  });
}

function runContributionCeremony(): ContributionResult {
  const config = setupContribution();

  // Get folders BEFORE the new one was created
  const contributionFolders = getContributionFolders().filter(
    (folder) => folder !== config.folderName,
  );

  if (contributionFolders.length < 1) {
    throw new Error("At least the initial folder is required.");
  }

  const lastFolder = contributionFolders[contributionFolders.length - 1];
  console.log(`Using source contribution from folder: ${lastFolder}`);

  const contributions = performContributions(config, lastFolder);

  createMetadataFiles(config, contributions);

  return { config, contributions };
}

function main(): void {
  try {
    // Check for required environment variables
    checkRequiredEnvVars();

    // Check if AWS CLI is installed
    if (!isAwsCliAvailable()) {
      console.error("❌ Error: AWS CLI is not installed or not in your PATH");
      console.error(
        "Please install AWS CLI using: npm install -g aws-cli or pip install awscli",
      );
      console.error("For more information, visit: https://aws.amazon.com/cli/");
      process.exit(1);
    }

    // Ensure we have the initial setup with required files
    ensureInitialSetup();

    // Download the latest contribution from S3 and ensure it has required files
    const latestFolder = downloadLatestContribution();

    // These cross-checks are now handled directly in the functions above
    // so we don't need to call them explicitly here

    const result = runContributionCeremony();

    console.log(
      `\nAll contributions complete! Your contributions are in the ${result.config.folderName} folder.`,
    );

    // Upload the new contribution to S3
    console.log(`\nUploading your contribution to S3...`);
    uploadToS3(result.config.folderName);

    // Cross-check the uploaded contribution with S3
    console.log(`\nVerifying uploaded contribution...`);
    crossCheckFilesWithS3(result.config.folderName);

    console.log("\nPlease commit and push this folder to the repository.");
    console.log(
      "\n⚠️ IMPORTANT: For security, entropy values were NOT saved anywhere and should now be gone from memory.",
    );
  } catch (error) {
    console.error("Error during contribution process:", error);
    process.exit(1);
  }
}

main();
