import * as fs from "fs-extra";
import * as path from "path";
import { execSync } from "child_process";
import {
  contributionRootFolder,
  downloadLatestContribution,
  getZkeyFiles,
  getCircuitR1cs,
  ensurePtauFile,
  uploadToS3,
  checkRequiredEnvVars,
  getContributionFolders,
  ensureInitialSetup,
  crossCheckFilesWithS3,
  ensureR1csFiles,
} from "./utils";

const BEACON_HASH =
  "0x81d94f995b977ba0ecff48f8a6687aeb90025f4142743d7135bcf9751195541d";
const BLOCK_NUMBER = "22038000";
const BEACON_ITERATIONS = 10; // Number of iterations for the beacon process
const FINAL_FOLDER_NAME = "0010_final";

function executeCommand(command: string): void {
  try {
    console.log(`Executing: ${command}`);
    execSync(command, { stdio: "inherit" });
  } catch (error) {
    console.error(`Error executing command: ${command}`);
    throw error;
  }
}

function getFinalFolderPath(): string {
  return path.join(contributionRootFolder, FINAL_FOLDER_NAME);
}

function applyRandomBeacon(lastContributionFolder: string): void {
  console.log(
    `\n🔶 Applying random beacon from Ethereum block #${BLOCK_NUMBER}...`,
  );
  console.log(`Block hash: ${BEACON_HASH}`);

  const finalFolderPath = getFinalFolderPath();
  const lastFolderPath = path.join(
    contributionRootFolder,
    lastContributionFolder,
  );
  const r1csFolderPath = ensureR1csFiles();

  // Get the zkey files from the last contribution
  const zkeyFiles = getZkeyFiles(lastContributionFolder);

  if (zkeyFiles.length === 0) {
    throw new Error(
      `No zkey files found in the last contribution folder: ${lastContributionFolder}`,
    );
  }

  // Process each zkey file
  for (const zkeyFile of zkeyFiles) {
    const lastZkeyPath = path.join(lastFolderPath, zkeyFile);
    const finalZkeyPath = path.join(finalFolderPath, zkeyFile);

    // Format the beacon hash without the '0x' prefix for snarkjs
    const beaconHashNoPrefix = BEACON_HASH.startsWith("0x")
      ? BEACON_HASH.substring(2)
      : BEACON_HASH;

    // Apply the beacon to generate the final zkey
    const beaconCommand = `snarkjs zkey beacon ${lastZkeyPath} ${finalZkeyPath} ${beaconHashNoPrefix} ${BEACON_ITERATIONS} -n="Final Beacon from Ethereum block #${BLOCK_NUMBER}"`;
    executeCommand(beaconCommand);

    // Extract circuit name from zkey filename
    const circuitName = path.basename(zkeyFile, ".zkey");

    // Find matching r1cs file in the r1cs folder
    const r1csFiles = fs
      .readdirSync(r1csFolderPath)
      .filter((file) => file.endsWith(".r1cs"));

    // Try to find exact match first
    let r1csFile = r1csFiles.find(
      (file) => path.basename(file, ".r1cs") === circuitName,
    );

    // If no exact match, try to find one with similar name
    if (!r1csFile) {
      console.log(
        `⚠️ No exact matching r1cs file found for ${zkeyFile}. Looking for partial matches...`,
      );
      r1csFile = r1csFiles.find(
        (file) =>
          file.toLowerCase().includes(circuitName.toLowerCase()) ||
          circuitName
            .toLowerCase()
            .includes(path.basename(file, ".r1cs").toLowerCase()),
      );
    }

    // If still no match, let user choose manually
    if (!r1csFile) {
      console.error(
        `❌ Error: Could not find matching r1cs file for ${zkeyFile}`,
      );
      console.error(`Available r1cs files: ${r1csFiles.join(", ")}`);
      throw new Error(`Please specify which r1cs file to use for ${zkeyFile}`);
    }

    const r1csFilePath = path.join(r1csFolderPath, r1csFile);
    console.log(`Using r1cs file: ${r1csFile} for zkey: ${zkeyFile}`);

    // Get the ptau file path
    const ptauFilePath = ensurePtauFile();

    // Verify the final zkey
    console.log(`\n🔶 Verifying the final zkey file...`);
    const verifyCommand = `snarkjs zkey verify ${r1csFilePath} ${ptauFilePath} ${finalZkeyPath}`;
    executeCommand(verifyCommand);

    // Export verification key
    console.log(`\n🔶 Exporting verification key...`);
    const vkeyPath = path.join(
      finalFolderPath,
      `${path.basename(zkeyFile, ".zkey")}_verification_key.json`,
    );
    const exportCommand = `snarkjs zkey export verificationkey ${finalZkeyPath} ${vkeyPath}`;
    executeCommand(exportCommand);

    console.log(
      `\n✅ Successfully generated and verified final zkey file: ${finalZkeyPath}`,
    );
    console.log(`✅ Verification key exported to: ${vkeyPath}`);
  }
}

function createBeaconMetadataFile(timestamp: string): void {
  const finalFolderPath = getFinalFolderPath();
  const metadataPath = path.join(
    finalFolderPath,
    "BeaconRandomnessMetadata.json",
  );

  const metadata = {
    blockNumber: BLOCK_NUMBER,
    blockHash: BEACON_HASH,
    iterations: BEACON_ITERATIONS,
    timestamp: timestamp,
  };

  fs.writeJsonSync(metadataPath, metadata, { spaces: 2 });
  console.log(`✅ Beacon metadata written to: ${metadataPath}`);
}

function createAttestationFile(timestamp: string): void {
  console.log(`\n🔶 Creating attestation file with contribution hashes...`);

  const finalFolderPath = getFinalFolderPath();
  const attestationPath = path.join(finalFolderPath, "FinalAttestationFile.md");

  // Get all zkey files in the final folder
  const zkeyFiles = fs
    .readdirSync(finalFolderPath)
    .filter((file) => file.endsWith(".zkey"));

  if (zkeyFiles.length === 0) {
    throw new Error(
      `No zkey files found in the final folder: ${FINAL_FOLDER_NAME}`,
    );
  }

  // Calculate SHA256 hashes for each zkey file
  const fileHashes: { filename: string; hash: string }[] = [];

  for (const zkeyFile of zkeyFiles) {
    const filePath = path.join(finalFolderPath, zkeyFile);
    // Use openssl to calculate SHA256 hash
    const hashCommand = `openssl dgst -sha256 ${filePath}`;
    const result = execSync(hashCommand, { encoding: "utf8" });

    // Extract hash from result (format: "SHA256(filepath)= hash")
    const hash = result.trim().split("= ")[1];
    fileHashes.push({ filename: zkeyFile, hash });
  }

  // Create attestation file content
  const attestationContent = `# Final Trusted Setup Ceremony Attestation

## Ceremony Information

- **Finalization Date**: ${timestamp}
- **Ethereum Block Number**: ${BLOCK_NUMBER}
- **Ethereum Block Hash**: ${BEACON_HASH}
- **Beacon Iterations**: ${BEACON_ITERATIONS}

## Final Contribution File Hashes

The following SHA256 hashes represent the final zkey files after applying the random beacon:

${fileHashes.map((file) => `- **${file.filename}**: \`${file.hash}\``).join("\n")}

## Ceremony Verification

The final parameters were verified using snarkjs with the corresponding circuit files.
The verification keys have been exported and are available in the same folder.

## Attestation

This attestation file was automatically generated as part of the Trusted Setup Ceremony finalization process.
The ceremony was finalized by applying a random beacon from Ethereum block #${BLOCK_NUMBER}.
`;

  // Write attestation file
  fs.writeFileSync(attestationPath, attestationContent);
  console.log(`✅ Attestation file with hashes written to: ${attestationPath}`);
}

function main(): void {
  try {
    console.log("🚀 Starting finalization of the trusted setup ceremony...");
    checkRequiredEnvVars();

    // Ensure the final folder exists
    fs.ensureDirSync(getFinalFolderPath());

    // Ensure the initial setup is available
    console.log(`\n📥 Ensuring initial setup is available...`);
    ensureInitialSetup();
    ensureR1csFiles();

    // Download the latest contribution if needed
    console.log("\n📥 Checking for latest contribution...");
    let latestFolder = downloadLatestContribution();

    if (!latestFolder) {
      const existingFolders = getContributionFolders();
      if (existingFolders.length === 0) {
        throw new Error(
          "No contributions found. Cannot finalize the ceremony.",
        );
      }

      latestFolder = existingFolders[existingFolders.length - 1];
    }

    console.log(`📋 Using latest contribution: ${latestFolder}`);

    // Apply the random beacon
    applyRandomBeacon(latestFolder);

    // Create attestation and metadata files
    const timestamp = new Date().toISOString();
    createAttestationFile(timestamp);
    createBeaconMetadataFile(timestamp);

    // Upload the final contribution to S3
    console.log("\n📤 Uploading final contribution to S3...");
    const uploaded = uploadToS3(FINAL_FOLDER_NAME);

    if (uploaded) {
      console.log("🎉 Final contribution successfully uploaded to S3.");

      // Perform a final cross-check to ensure everything is in sync
      console.log("\n🔍 Performing final verification of files...");
      crossCheckFilesWithS3(FINAL_FOLDER_NAME);
    } else {
      console.warn("⚠️ Upload to S3 failed or was skipped.");
    }

    console.log("\n🎉 Trusted Setup Ceremony has been successfully finalized!");
    console.log(`Final contribution is available in: ${getFinalFolderPath()}`);
  } catch (error) {
    console.error(`\n❌ Error finalizing the ceremony: ${error}`);
    process.exit(1);
  }
}

// Run the main function
main();
