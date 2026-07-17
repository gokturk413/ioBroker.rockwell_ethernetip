'use strict';
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const os = require('node:os');
const crypto = require('node:crypto');

const PACKAGE_PREFIX = 'iobroker.rockwell_ethernetip';

/**
 * node `process.platform`-`process.arch` → the .NET RID that names prebuilds/<rid>/.
 *
 * @param platform - node's `process.platform` (win32, linux, darwin)
 * @param arch - node's `process.arch` (x64, arm64)
 * @returns the matching .NET RID, or `<platform>-<arch>` when unsupported
 */
function ridFor(platform, arch) {
	return (
		{
			'win32-x64': 'win-x64',
			'linux-x64': 'linux-x64',
			'linux-arm64': 'linux-arm64',
			'darwin-arm64': 'osx-arm64',
			'darwin-x64': 'osx-x64',
		}[`${platform}-${arch}`] || `${platform}-${arch}`
	);
}

/**
 * Name of the optional dependency that ships this platform's engine binary.
 *
 * @param platform - node's `process.platform`
 * @param arch - node's `process.arch`
 * @returns the npm package name, e.g. `iobroker.rockwell_ethernetip-linux-arm64`
 */
function platformPackage(platform, arch) {
	return `${PACKAGE_PREFIX}-${platform}-${arch}`;
}

/**
 * File name the AOT publish gives the native module. It is never `.node` — the
 * prebuilds and the published platform packages are what rename it.
 *
 * @param platform - node's `process.platform`
 * @returns the artifact name inside `.../publish/`
 */
function devPublishName(platform) {
	if (platform === 'win32') {
		return 'rockwell_engine.dll';
	}
	return platform === 'darwin' ? 'rockwell_engine.dylib' : 'rockwell_engine.so';
}

/**
 * Decompresses `<file>.gz` next to itself (or into a per-user temp cache when
 * node_modules is read-only) and returns the path to the usable `.node`. The
 * engine binaries ship gzip-compressed inside the single adapter package — this
 * expands the one matching the host on first load only.
 *
 * @param gzPath - absolute path of the `.node.gz` artifact
 * @param log - optional ioBroker logger
 * @returns absolute path of the decompressed `.node`, or null on failure
 */
function decompress(gzPath, log) {
	try {
		const target = gzPath.slice(0, -3); // strip ".gz"
		if (fs.existsSync(target) && fs.statSync(target).mtimeMs >= fs.statSync(gzPath).mtimeMs) {
			return target; // already expanded and current
		}
		const buf = zlib.gunzipSync(fs.readFileSync(gzPath));
		try {
			fs.writeFileSync(target, buf);
			return target;
		} catch {
			// read-only install → expand into a content-addressed temp cache
			const dir = path.join(os.tmpdir(), 'iobroker.rockwell_ethernetip-engine');
			fs.mkdirSync(dir, { recursive: true });
			const cached = path.join(
				dir,
				`rockwell_engine-${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}.node`,
			);
			if (!fs.existsSync(cached)) {
				fs.writeFileSync(cached, buf);
			}
			return cached;
		}
	} catch (e) {
		if (log && log.debug) {
			log.debug(`engineBridge: could not decompress ${gzPath}: ${e.message}`);
		}
		return null;
	}
}

/**
 * Loads the platform-specific AOT engine addon and returns its Engine surface
 * (ping/version/onEvent/init/start/stop/write/read/lease/getAlarms/getStats/
 * getLicenseInfo/parseProject).
 *
 * Search order: an already-expanded `prebuilds/<rid>/rockwell_engine.node`
 * (local build), the bundled `prebuilds/<rid>/rockwell_engine.node.gz` (how
 * released installs get it — all platforms ship in the one package, compressed,
 * and only the matching one is expanded), the dev publish output, and finally a
 * legacy per-platform package if one is still installed.
 *
 * @param log - optional ioBroker logger; only `debug` is used
 * @returns the addon's `Engine` namespace
 * @throws when no engine binary exists for this platform, naming every path tried
 */
function load(log) {
	const rid = ridFor(process.platform, process.arch);
	const tried = [];

	const prebuild = path.join(__dirname, '..', 'prebuilds', rid, 'rockwell_engine.node');
	const bundledGz = `${prebuild}.gz`;
	const devPublish = path.join(
		__dirname,
		'..',
		'native',
		'RockwellEngine.Node',
		'bin',
		'Release',
		'net10.0',
		rid,
		'publish',
		devPublishName(process.platform),
	);

	// 1. already-expanded prebuild (local build / previous decompress)
	if (fs.existsSync(prebuild)) {
		return unwrap(prebuild, log);
	}
	tried.push(prebuild);

	// 2. bundled compressed binary — expand the matching one on first load
	if (fs.existsSync(bundledGz)) {
		const expanded = decompress(bundledGz, log);
		if (expanded) {
			return unwrap(expanded, log);
		}
		tried.push(`${bundledGz} (decompress failed)`);
	} else {
		tried.push(bundledGz);
	}

	// 3. dev publish output
	if (fs.existsSync(devPublish)) {
		return unwrap(devPublish, log);
	}
	tried.push(devPublish);

	// 4. legacy per-platform package (pre-0.0.14 installs may still have one)
	const pkg = platformPackage(process.platform, process.arch);
	try {
		return unwrap(require.resolve(`${pkg}/rockwell_engine.node`), log);
	} catch (e) {
		tried.push(`${pkg} (${e.code === 'MODULE_NOT_FOUND' ? 'not installed' : e.message})`);
	}

	throw new Error(`rockwell engine addon not found for ${rid}; tried:\n${tried.join('\n')}`);
}

function unwrap(modulePath, log) {
	if (log && log.debug) {
		log.debug(`engineBridge: loading ${modulePath}`);
	}
	const mod = require(modulePath);
	if (!mod.Engine) {
		throw new Error(`engineBridge: ${modulePath} has no Engine export`);
	}
	return mod.Engine;
}

module.exports = { load, ridFor, platformPackage, devPublishName };
