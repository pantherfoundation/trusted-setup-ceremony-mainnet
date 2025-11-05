import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs-extra";
import {
  contributionRootFolder,
  getContributionFolders,
  getZkeyFiles,
  downloadFromS3,
  ensureInitialSetup,
  ensurePtauFile,
  checkRequiredEnvVars,
  isAwsCliAvailable,
} from "./utils";

interface VerificationResult {
  contributionFolder: string;
  circuitName: string;
  success: boolean;
  errorMessage?: string;
}

function verifyZkeyContribution(
  initialZkeyFile: string,
  ptauFile: string,
  contributionZkeyFile: string,
): { success: boolean; errorMessage?: string } {
  try {
    // Use the zkvi command with the initial zkey file
    execSync(
      `node --max-old-space-size=8192 ./node_modules/.bin/snarkjs zkvi ${initialZkeyFile} ${ptauFile} ${contributionZkeyFile}`,
      {
        stdio: "inherit",
      },
    );
    console.log(
      `✅ ${path.basename(contributionZkeyFile)} verification successful!`,
    );
    return { success: true };
  } catch (error) {
    console.error(`❌ Failed to verify ${path.basename(contributionZkeyFile)}`);
    let errorMessage = "Unknown error";
    if (error instanceof Error) {
      console.error(error.message);
      errorMessage = error.message;
    }
    return { success: false, errorMessage };
  }
}

function verifyContribution(
  contributionFolder: string,
  initialFolder: string,
  ptauFile: string,
  results: VerificationResult[],
): boolean {
  console.log(`\nVerifying contributions in ${contributionFolder}...`);

  // Get contribution zkey files
  const contributionZkeyFiles = getZkeyFiles(contributionFolder);
  if (contributionZkeyFiles.length === 0) {
    console.error(`No .zkey files found in ${contributionFolder}`);
    return false;
  }

  // Get initial zkey files
  const initialZkeyFiles = getZkeyFiles(initialFolder);
  if (initialZkeyFiles.length === 0) {
    console.error(`No .zkey files found in ${initialFolder}`);
    return false;
  }

  let allSuccessful = true;
  for (const zkeyFile of contributionZkeyFiles) {
    // Extract circuit name from the zkey file
    const circuitName = path.basename(zkeyFile, ".zkey");

    // Find the matching initial zkey file with the same name
    const initialZkeyFile = initialZkeyFiles.find((file) => file === zkeyFile);

    if (!initialZkeyFile) {
      console.error(
        `❌ Could not find matching initial zkey file for ${zkeyFile}`,
      );
      results.push({
        contributionFolder,
        circuitName,
        success: false,
        errorMessage: "Missing initial zkey file",
      });
      allSuccessful = false;
      continue;
    }

    const fullInitialZkeyPath = path.join(
      contributionRootFolder,
      initialFolder,
      initialZkeyFile,
    );
    const fullContributionZkeyPath = path.join(
      contributionRootFolder,
      contributionFolder,
      zkeyFile,
    );

    console.log(`\nVerifying ${zkeyFile} using initial zkey file...`);
    const { success, errorMessage } = verifyZkeyContribution(
      fullInitialZkeyPath,
      ptauFile,
      fullContributionZkeyPath,
    );

    results.push({
      contributionFolder,
      circuitName,
      success,
      errorMessage,
    });

    if (!success) {
      allSuccessful = false;
    }
  }

  return allSuccessful;
}

function printResultsTable(results: VerificationResult[]): void {
  console.log("\n\n=== VERIFICATION SUMMARY ===\n");

  // Group results by contribution folder
  const folderGroups = results.reduce(
    (acc, result) => {
      if (!acc[result.contributionFolder]) {
        acc[result.contributionFolder] = [];
      }
      acc[result.contributionFolder].push(result);
      return acc;
    },
    {} as Record<string, VerificationResult[]>,
  );

  // Get all circuit names for table headers
  const allCircuits = [...new Set(results.map((r) => r.circuitName))].sort();

  // Calculate column widths
  const folderWidth = Math.max(
    20,
    ...Object.keys(folderGroups).map((f) => f.length),
  );
  const circuitWidth = Math.max(15, ...allCircuits.map((c) => c.length));

  // Print header
  console.log(
    `${"Contribution".padEnd(folderWidth)} | ${allCircuits.map((c) => c.padEnd(circuitWidth)).join(" | ")}`,
  );
  console.log(
    `${"-".repeat(folderWidth)} | ${allCircuits.map(() => "-".repeat(circuitWidth)).join(" | ")}`,
  );

  // Print rows for each contribution folder
  Object.keys(folderGroups)
    .sort()
    .forEach((folder) => {
      const folderResults = folderGroups[folder];
      const resultByCircuit: Record<string, string> = {};

      // Prepare results for each circuit
      folderResults.forEach((result) => {
        resultByCircuit[result.circuitName] = result.success
          ? "✅ PASS"
          : "❌ FAIL";
      });

      // Print the row
      console.log(
        `${folder.padEnd(folderWidth)} | ${allCircuits
          .map((circuit) =>
            (resultByCircuit[circuit] || "⚠️ N/A").padEnd(circuitWidth),
          )
          .join(" | ")}`,
      );
    });

  // Print overall stats
  const totalTests = results.length;
  const passedTests = results.filter((r) => r.success).length;
  const failedTests = totalTests - passedTests;

  console.log("\n=== OVERALL RESULTS ===");
  console.log(`Total verification tests: ${totalTests}`);
  console.log(`Passed: ${passedTests}`);
  console.log(`Failed: ${failedTests}`);

  if (failedTests > 0) {
    console.log("\n=== FAILED VERIFICATIONS ===");
    results
      .filter((r) => !r.success)
      .forEach((result) => {
        console.log(
          `❌ ${result.contributionFolder} - ${result.circuitName}: ${result.errorMessage || "Verification failed"}`,
        );
      });
  }
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

    // Create the contributions directory if it doesn't exist
    fs.ensureDirSync(contributionRootFolder);

    // Ensure we have the PTAU file
    const ptauFile = ensurePtauFile();
    console.log(`Using ptau file: ${ptauFile}`);

    // Ensure we have the initial setup
    ensureInitialSetup();

    // Check if we need to download more contributions
    const localContributionFolders = getContributionFolders();

    for (const folder of localContributionFolders) {
      if (getZkeyFiles(folder).length === 0) downloadFromS3(folder);
    }

    // Refresh the list of contribution folders after potential downloads
    const contributionFolders = getContributionFolders();
    console.log(`Found ${contributionFolders.length} contributions`);

    if (contributionFolders.length < 2) {
      console.log("At least two contributions are needed for verification.");
      console.log(
        "There's only the initial setup folder. Nothing to verify yet.",
      );
      return;
    }

    const initialFolder = contributionFolders[0]; // 0000_initial

    // Track verification results
    const verificationResults: VerificationResult[] = [];

    // Verify each contribution individually, starting from the first non-initial contribution
    for (let i = 1; i < contributionFolders.length; i++) {
      const currentFolder = contributionFolders[i];
      verifyContribution(
        currentFolder,
        initialFolder,
        ptauFile,
        verificationResults,
      );
    }

    // Print summary table
    printResultsTable(verificationResults);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Unknown error occurred: ${error}`);
    }
    process.exit(1);
  }
}

main();
