import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const rootDir = resolve(".");
const artifactPath = resolve(rootDir, "dist/release-assets/yaos-server.zip");
const tempDir = mkdtempSync(join(tmpdir(), "yaos-server-update-test-"));
const repoDir = join(tempDir, "repo");

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: repoDir,
		stdio: "inherit",
		...options,
	});
}

function read(relativePath) {
	return readFileSync(join(repoDir, relativePath), "utf8");
}

function writeArtifactManifest(artifactDir, updateOwnedPaths) {
	writeFileSync(
		join(artifactDir, "yaos-server-manifest.json"),
		`${JSON.stringify(
			{
				serverVersion: "local-test",
				pluginVersion: "local-test",
				updateOwnedPaths,
				migrationRequired: false,
			},
			null,
			2,
		)}\n`,
	);
}

function zipArtifact(artifactDir, zipPath, preserveSymlinks = false) {
	const zipArgs = preserveSymlinks ? ["-q", "-r", "-y", zipPath, "."] : ["-q", "-r", zipPath, "."];
	execFileSync("zip", zipArgs, {
		cwd: artifactDir,
		stdio: "inherit",
	});
}

function runUpdate(artifactPath, extraEnv = {}) {
	return execFileSync("bun", ["scripts/update-from-release.mjs"], {
		cwd: repoDir,
		encoding: "utf8",
		env: {
			...process.env,
			YAOS_RELEASE_FILE: artifactPath,
			...extraEnv,
		},
	});
}

function expectUpdateFailure(artifactPath, extraEnv = {}) {
	let failure = null;
	try {
		runUpdate(artifactPath, extraEnv);
	} catch (error) {
		failure = error;
	}
	if (!failure) {
		throw new Error("Update unexpectedly succeeded for malicious artifact");
	}
	return String(failure?.stderr ?? failure?.message ?? failure);
}

try {
	cpSync(resolve(rootDir, "server"), repoDir, { recursive: true });

	run("git", ["init", "-q"]);
	run("git", ["config", "user.name", "YAOS Local Test"]);
	run("git", ["config", "user.email", "local-test@yaos"]);
	run("git", ["add", "-A"]);
	run("git", ["commit", "-qm", "baseline"]);

	const baselineVersion = read("src/version.ts");
	const baselineSelfHosted = read("SELF_HOSTED.md");
	const currentServerVersionMatch = baselineVersion.match(/SERVER_VERSION = "([^"]+)"/);
	if (!currentServerVersionMatch) {
		throw new Error("Unable to read current server version from src/version.ts");
	}
	const currentServerVersion = currentServerVersionMatch[1];
	const outsideTraversalPath = join(tempDir, "outside-traversal.txt");
	const outsideTraversalBaseline = "do-not-delete";
	writeFileSync(outsideTraversalPath, outsideTraversalBaseline);

	const traversalArtifactDir = join(tempDir, "traversal-artifact");
	mkdirSync(traversalArtifactDir, { recursive: true });
	writeArtifactManifest(traversalArtifactDir, ["../outside-traversal.txt"]);
	const traversalArtifactPath = join(tempDir, "traversal-artifact.zip");
	zipArtifact(traversalArtifactDir, traversalArtifactPath);

	const traversalFailure = expectUpdateFailure(traversalArtifactPath);
	if (!/Invalid update-owned path|escapes root|Unsafe symlink/.test(traversalFailure)) {
		throw new Error(`Traversal update did not fail as expected: ${traversalFailure}`);
	}
	if (readFileSync(outsideTraversalPath, "utf8") !== outsideTraversalBaseline) {
		throw new Error("Traversal test failed: file outside repo root was touched");
	}

	const outsideSymlinkPath = join(tempDir, "outside-symlink.txt");
	const outsideSymlinkBaseline = "do-not-overwrite";
	writeFileSync(outsideSymlinkPath, outsideSymlinkBaseline);

	const symlinkArtifactDir = join(tempDir, "symlink-artifact");
	mkdirSync(join(symlinkArtifactDir, "src"), { recursive: true });
	writeFileSync(join(symlinkArtifactDir, "src", "version.ts"), "export const x = 1;\n");
	symlinkSync(outsideSymlinkPath, join(symlinkArtifactDir, "src", "escape"));
	writeArtifactManifest(symlinkArtifactDir, ["src"]);
	const symlinkArtifactPath = join(tempDir, "symlink-artifact.zip");
	zipArtifact(symlinkArtifactDir, symlinkArtifactPath, true);

	const symlinkFailure = expectUpdateFailure(symlinkArtifactPath);
	if (!/symlink/.test(symlinkFailure)) {
		throw new Error(`Symlink update did not fail as expected: ${symlinkFailure}`);
	}
	if (readFileSync(outsideSymlinkPath, "utf8") !== outsideSymlinkBaseline) {
		throw new Error("Symlink test failed: file outside repo root was touched");
	}

	writeFileSync(
		join(repoDir, "src/version.ts"),
		baselineVersion.replace(
			`SERVER_VERSION = "${currentServerVersion}"`,
			'SERVER_VERSION = "0.1.9"',
		),
	);
	writeFileSync(join(repoDir, "SELF_HOSTED.md"), `${baselineSelfHosted}\n<!-- local-test-preserved -->\n`);
	run("git", ["add", "-A"]);
	run("git", ["commit", "-qm", "simulate older deployed server"]);

	runUpdate(artifactPath);

	const updatedVersion = read("src/version.ts");
	if (updatedVersion !== baselineVersion) {
		throw new Error("Update test failed: src/version.ts was not restored from the artifact");
	}

	const updatedSelfHosted = read("SELF_HOSTED.md");
	if (!updatedSelfHosted.includes("local-test-preserved")) {
		throw new Error("Update test failed: protected SELF_HOSTED.md changes were overwritten");
	}

	run("git", ["add", "-A"]);
	run("git", ["commit", "-qm", `yaos(server): update to ${currentServerVersion}`]);
	run("bun", ["scripts/revert-last-update.mjs"]);

	const revertedVersion = read("src/version.ts");
	if (!revertedVersion.includes('SERVER_VERSION = "0.1.9"')) {
		throw new Error("Revert test failed: update-owned files were not restored");
	}

	const revertedSelfHosted = read("SELF_HOSTED.md");
	if (!revertedSelfHosted.includes("local-test-preserved")) {
		throw new Error("Revert test failed: protected SELF_HOSTED.md changes were lost");
	}

	console.log("Local YAOS server update/revert smoke test passed.");
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
