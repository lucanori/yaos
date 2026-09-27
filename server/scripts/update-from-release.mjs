import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	lstatSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, posix, relative, resolve, sep, win32 } from "node:path";

const defaultReleaseRepo = "kavinsood/yaos";
const releaseRepo = process.env.YAOS_RELEASE_REPO?.trim() || defaultReleaseRepo;
const releaseVersion = process.env.YAOS_RELEASE_VERSION?.trim() ?? "";
const explicitArtifactInput =
	process.env.YAOS_RELEASE_FILE?.trim() ?? process.env.YAOS_RELEASE_URL?.trim() ?? "";
const artifactSource = explicitArtifactInput
	? resolveArtifactSource(explicitArtifactInput)
	: releaseVersion
		? {
				type: "remote",
				label: `GitHub release ${releaseRepo}@${releaseVersion}`,
				value: `https://github.com/${releaseRepo}/releases/download/${releaseVersion}/yaos-server.zip`,
			}
		: {
				type: "remote",
				label: `latest GitHub release from ${releaseRepo}`,
				value: `https://github.com/${releaseRepo}/releases/latest/download/yaos-server.zip`,
			};

const repoRoot = resolve(".");
const tempDir = mkdtempSync(join(tmpdir(), "yaos-server-update-"));
const zipPath = join(tempDir, "yaos-server.zip");
const extractDir = join(tempDir, "extract");
const protectedPrefixes = [".github", ".github/"];
const allowMigrationUpdate = process.env.YAOS_ALLOW_MIGRATION_UPDATE?.trim().toLowerCase() === "true";

function resolveArtifactSource(input) {
	if (/^https?:\/\//i.test(input)) {
		return { type: "remote", label: input, value: input };
	}

	const normalizedPath = input.startsWith("file://") ? new URL(input) : resolve(input);
	const filePath = normalizedPath instanceof URL ? normalizedPath : normalizedPath;
	if (!existsSync(filePath)) {
		throw new Error(`Local YAOS server artifact was not found: ${filePath}`);
	}
	return { type: "local", label: String(filePath), value: String(filePath) };
}

function normalizeManifestOwnedPath(relativePath) {
	if (typeof relativePath !== "string" || relativePath.trim() === "") {
		throw new Error(`Invalid update-owned path in artifact: ${String(relativePath)}`);
	}
	if (relativePath.includes("\0")) {
		throw new Error(`Invalid update-owned path in artifact: ${relativePath}`);
	}
	if (relativePath.includes("\\")) {
		throw new Error(`Invalid update-owned path in artifact: ${relativePath}`);
	}
	if (posix.isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
		throw new Error(`Invalid update-owned path in artifact: ${relativePath}`);
	}
	if (relativePath.split("/").some((segment) => segment === "..")) {
		throw new Error(`Invalid update-owned path in artifact: ${relativePath}`);
	}
	const normalizedPath = normalize(relativePath).replaceAll("\\", "/");
	if (normalizedPath === ".") {
		throw new Error(`Invalid update-owned path in artifact: ${relativePath}`);
	}
	const segments = normalizedPath.split("/");
	if (segments.some((segment) => segment === "")) {
		throw new Error(`Invalid update-owned path in artifact: ${relativePath}`);
	}
	return normalizedPath;
}

function resolveManifestOwnedPath(rootPath, relativePath) {
	const normalizedPath = normalizeManifestOwnedPath(relativePath);
	const absolutePath = resolve(rootPath, normalizedPath);
	const rootRelativePath = relative(rootPath, absolutePath);
	if (
		rootRelativePath.startsWith("..") ||
		posix.isAbsolute(rootRelativePath) ||
		win32.isAbsolute(rootRelativePath)
	) {
		throw new Error(`Update-owned path escapes root: ${relativePath}`);
	}
	return { absolutePath, normalizedPath };
}

function assertNoSymlinkTraversal(rootPath, absolutePath, displayPath) {
	const rootRelativePath = relative(rootPath, absolutePath);
	const pathSegments = rootRelativePath.split(sep).filter(Boolean);
	let currentPath = rootPath;
	for (const segment of pathSegments) {
		currentPath = join(currentPath, segment);
		if (existsSync(currentPath) && lstatSync(currentPath).isSymbolicLink()) {
			throw new Error(`Unsafe symlink entry in update-owned path: ${displayPath}`);
		}
	}
}

function assertSafeSourceTree(sourcePath, displayPath) {
	const sourceStats = lstatSync(sourcePath);
	if (sourceStats.isSymbolicLink()) {
		throw new Error(`Unsafe symlink entry in update-owned path: ${displayPath}`);
	}
	if (sourceStats.isDirectory()) {
		for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
			const childPath = join(sourcePath, entry.name);
			const childDisplayPath = `${displayPath}/${entry.name}`;
			if (entry.isSymbolicLink()) {
				throw new Error(`Unsafe symlink entry in update-owned path: ${childDisplayPath}`);
			}
			if (entry.isDirectory()) {
				assertSafeSourceTree(childPath, childDisplayPath);
				continue;
			}
			if (!entry.isFile()) {
				throw new Error(`Unsupported update-owned entry type in artifact: ${childDisplayPath}`);
			}
		}
		return;
	}
	if (!sourceStats.isFile()) {
		throw new Error(`Unsupported update-owned entry type in artifact: ${displayPath}`);
	}
}

function applyUpdateOwnedPath(relativePath) {
	const { absolutePath: sourcePath, normalizedPath } = resolveManifestOwnedPath(extractDir, relativePath);
	const { absolutePath: targetPath } = resolveManifestOwnedPath(repoRoot, relativePath);
	assertNoSymlinkTraversal(extractDir, sourcePath, normalizedPath);
	assertNoSymlinkTraversal(repoRoot, targetPath, normalizedPath);
	assertSafeSourceTree(sourcePath, normalizedPath);
	rmSync(targetPath, { recursive: true, force: true });
	const sourceStats = statSync(sourcePath);
	if (sourceStats.isDirectory()) {
		cpSync(sourcePath, targetPath, { recursive: true });
		return;
	}
	mkdirSync(dirname(targetPath), { recursive: true });
	cpSync(sourcePath, targetPath);
}

async function stageArtifactZip() {
	if (artifactSource.type === "local") {
		console.log(`Using local YAOS server artifact from ${artifactSource.label}`);
		cpSync(artifactSource.value, zipPath);
		return;
	}

	console.log(`Downloading YAOS server artifact from ${artifactSource.label}`);
	const response = await fetch(artifactSource.value, {
		redirect: "follow",
		headers: {
			"User-Agent": "yaos-server-updater",
		},
	});
	if (!response.ok) {
		const baseMessage = `Download failed (${response.status}) for ${artifactSource.value}`;
		if (response.status === 404) {
			throw new Error(
				[
					baseMessage,
					"Expected release assets were not found.",
					"Make sure the selected release includes BOTH 'yaos-server.zip' and 'update-manifest.json'.",
					`release_repo=${releaseRepo}${releaseVersion ? ` version=${releaseVersion}` : " version=latest"}`,
				].join(" "),
			);
		}
		throw new Error(baseMessage);
	}
	writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
}

async function main() {
	await stageArtifactZip();
	mkdirSync(extractDir, { recursive: true });
	execFileSync("unzip", ["-q", zipPath, "-d", extractDir], { stdio: "inherit" });

	const manifestPath = join(extractDir, "yaos-server-manifest.json");
	const rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (!Array.isArray(rawManifest.updateOwnedPaths)) {
		throw new Error("Artifact manifest is missing updateOwnedPaths");
	}
	if (rawManifest.migrationRequired === true && !allowMigrationUpdate) {
		throw new Error(
			[
				"STOP: this YAOS release is marked as migration-required.",
				"Automatic updates are disabled for migration-required releases to protect self-hosted server state.",
				"Read the upgrade guide and apply the migration manually before re-running this updater.",
				"If you intentionally want to bypass this guard, set YAOS_ALLOW_MIGRATION_UPDATE=true.",
			].join(" "),
		);
	}

	for (const relativePath of rawManifest.updateOwnedPaths) {
		if (typeof relativePath !== "string" || relativePath.trim() === "") {
			throw new Error(`Invalid update-owned path in artifact: ${String(relativePath)}`);
		}
		if (protectedPrefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(prefix))) {
			console.log(`Skipping protected path ${relativePath}`);
			continue;
		}
		applyUpdateOwnedPath(relativePath);
		console.log(`Updated ${relativePath}`);
	}

	console.log(
		`Applied YAOS server artifact${rawManifest.serverVersion ? ` ${rawManifest.serverVersion}` : ""}`,
	);
}

await main().finally(() => {
	rmSync(tempDir, { recursive: true, force: true });
});
