'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.2
 * The whole PLC path runs through the .NET AOT engine (native/): config in,
 * tiered polling out, batched change events into ioBroker states, writes gated
 * and encoded in C#, alarms and on-demand reads over sendTo.
 */

const fs = require('node:fs');
const utils = require('@iobroker/adapter-core');
const { load } = require('./lib/engineBridge');
const { resolveProjectFile, writeProjectChunk } = require('./lib/projectFile');

const HEARTBEAT_TIMEOUT_MS = 30000;
const WATCHDOG_INTERVAL_MS = 10000;

class RockwellEthernetip extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	constructor(options) {
		super({
			...options,
			name: 'rockwell-enip',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));

		this.engine = null;
		this.pathToState = {}; // CIP path -> ioBroker object id
		this.tagByObjectId = {}; // object id -> tag config (write-back)
		this.objectIdByName = {}; // tag.name -> object id (EP apply, subscribe)
		this.terminating = false; // set on unload so long object builds abort cleanly
		this.buildingObjects = false; // true while (re)building the tree — gates writes/push/commands
		this.licenseValid = false;
		this.lastHeartbeat = 0;
		this.watchdog = null;
	}

	/** Build the engine config JSON object from the adapter config. */
	engineConfig() {
		const c = this.config;
		// EP states are file-served, never polled — the engine must not see them.
		const tags = (c.tags || [])
			.filter(t => (t.type || '').toUpperCase() !== 'EP')
			.map(t => ({
				name: t.name,
				address: t.address || '',
				type: t.type || 'DINT',
				tier: t.tier || 'normal',
				// Every tag is writable: control happens from ioBroker states and from
				// PLC logic alike — per-tag write gating was removed from the UI.
				write: true,
			}));
		return {
			gateway: c.plcHost,
			path: `1,${c.plcSlot || 0}`,
			licenseKey: c.licenseKey || '',
			mode: c.mode || 'standard',
			projectFile: c.projectFile || '',
			cipPayload: c.cipPayload || 0,
			parallelConnections: c.parallelConnections || 1,
			instance: this.instance,
			pushMode: !!c.pushMode,
			pushTransport: c.pushTransport || 'poll',
			pushPort: c.pushPort || 44819,
			timeoutMs: c.connectionTimeout || 5000,
			pollTiers: c.pollTiers || { normalMs: c.pollInterval || 1000 },
			tags,
		};
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		await this.setState('info.connection', false, true);

		// Always create ioBroker state objects on startup, regardless of PLC connectivity
		await this.createStateObjects();
		await this.raiseObjectsWarnLimit();

		if (!this.config.plcHost) {
			this.log.warn('PLC host is not configured. Please configure the adapter.');
			return;
		}

		try {
			this.engine = load(this.log);
		} catch (e) {
			this.log.error(`Engine addon could not be loaded: ${e.message}`);
			return;
		}

		this.log.info(
			`Starting engine for PLC at ${this.config.plcHost}, Slot ${this.config.plcSlot} (engine ${this.engine.version()})`,
		);
		this.engine.onEvent(json => this.onEngineEvent(json));
		this.engine.init(JSON.stringify(this.engineConfig()));
		this.engine.start();
		const pollCount = (this.config.tags || []).filter(t => (t.type || '').toUpperCase() !== 'EP').length;
		this.log.info(
			`Engine started — resolving ${pollCount} tag(s) on the PLC. The first poll pass can take a few minutes at ` +
				`this scale while tag handles are established; values appear once it completes (this is normal).`,
		);
		this.subscribeConfiguredStates();
		this.applyEpStates().catch(e => this.log.debug(`EP states skipped: ${e.message}`));

		this.lastHeartbeat = Date.now();
		this.watchdog = this.setInterval(() => {
			if (!this.licenseValid) {
				return;
			} // engine refused to start — nothing to restart
			if (Date.now() - this.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
				this.log.warn('engine heartbeat lost — restarting engine');
				this.restartEngine();
			}
		}, WATCHDOG_INTERVAL_MS);
	}

	/** Stop + re-init + start the engine with the current config. */
	restartEngine() {
		if (!this.engine) {
			return;
		}
		try {
			this.engine.stop();
		} catch (e) {
			this.log.warn(`engine stop failed: ${e.message}`);
		}
		this.engine.init(JSON.stringify(this.engineConfig()));
		this.engine.start();
		this.lastHeartbeat = Date.now();
	}

	/**
	 * Single sink for all engine events (JSON strings posted onto the JS thread).
	 *
	 * @param json - one event envelope: changes | connection | heartbeat | license
	 */
	onEngineEvent(json) {
		let ev;
		try {
			ev = JSON.parse(json);
		} catch {
			return;
		}
		if (ev.type === 'changes') {
			if (this.buildingObjects) {
				return; // do not push values into the tree while it is being (re)built
			}
			const fromPush = ev.src === 'push';
			for (const c of ev.data) {
				if (fromPush) {
					// test visibility: each pushed change at info with ms, burst-guarded
					const now = Date.now();
					if (!this.pushLogWin || now - this.pushLogWin.start >= 1000) {
						if (this.pushLogWin && this.pushLogWin.suppressed > 0) {
							this.log.info(`push: +${this.pushLogWin.suppressed} more change(s) in that second`);
						}
						this.pushLogWin = { start: now, count: 0, suppressed: 0 };
					}
					if (this.pushLogWin.count < 20) {
						this.pushLogWin.count++;
						const d = new Date(c.TsMs || now);
						const hh = d.toTimeString().slice(0, 8);
						const ms = String((c.TsMs || now) % 1000).padStart(3, '0');
						this.log.info(`push: ${hh}.${ms} ${c.Path} = ${c.Value}`);
					} else {
						this.pushLogWin.suppressed++;
					}
				}
				const stateId = this.pathToState[c.Path];
				if (stateId) {
					const tag = this.tagByObjectId[stateId];
					const val = tag ? this.coerceValue(c.Value, this.getStateType(tag.type)) : c.Value;
					this.setState(stateId, { val, ack: true, q: c.Quality === 'Good' ? 0 : 0x42 }).catch(e =>
						this.log.warn(`setState ${stateId}: ${e.message}`),
					);
				}
			}
		} else if (ev.type === 'connection') {
			const connected = !!ev.connected;
			this.setState('info.connection', connected, true);
			// Stale-data signalling, the ioBroker equivalent of an OPC/KEPServer "Bad"
			// quality: when the PLC link drops, every polled tag keeps its last value but
			// gets a not-connected quality (0x42); when it comes back, quality returns to
			// good (0). A dashboard or script can treat q !== 0 as "old data". Only fires
			// on an actual connected↔disconnected transition.
			if (this.plcConnected === true && !connected) {
				this.setAllTagQuality(true);
			} else if (this.plcConnected === false && connected) {
				this.setAllTagQuality(false);
			}
			this.plcConnected = connected;
		} else if (ev.type === 'heartbeat') {
			this.lastHeartbeat = Date.now();
			// capacity diagnostics: how long each tier's poll pass really takes
			this.heartbeatCount = (this.heartbeatCount || 0) + 1;
			if (this.heartbeatCount % 6 === 0 && this.engine) {
				try {
					const st = JSON.parse(this.engine.getStats());
					const push =
						st.push && st.push.enabled
							? ` | push: ${st.push.connected ? 'ok' : 'DOWN'}, ${st.push.groups} groups, ${st.push.pushedTags} tags, ${st.push.events} events (${st.push.dirtyReads} reads)`
							: '';
					this.log.info(
						`poll pass ms: ${JSON.stringify(st.passMs)} (cached ${st.cachedCount}/${st.tagCount})${push}`,
					);
				} catch {
					/* stats are best-effort */
				}
			}
		} else if (ev.type === 'log') {
			// engine-side diagnostics (push group build warnings etc.)
			const level = ev.level === 'error' ? 'error' : ev.level === 'info' ? 'info' : 'warn';
			this.log[level](`engine: ${ev.message}`);
		} else if (ev.type === 'license') {
			this.licenseValid = !!ev.valid;
			if (ev.valid) {
				this.log.info(`License: ${ev.message}`);
			} else if (ev.freeEligible) {
				// no key, but within the free envelope (instance 0, tag limit) — not an error
				this.log.info(`License: free tier active — ${ev.message}`);
			} else {
				this.log.error(`License: ${ev.message}`);
			}
		}
	}

	/**
	 * Replace characters ioBroker forbids in an object-id segment (the engine may
	 * emit synthetic nodes such as "@Alarms"); the dot separator is handled by the
	 * caller. Never returns an empty segment.
	 *
	 * @param seg - one dot-delimited path segment
	 * @returns the segment with every char outside [A-Za-z0-9_-] turned into "_"
	 */
	sanitizeSegment(seg) {
		const s = String(seg).replace(/[^A-Za-z0-9_-]/g, '_');
		return s || '_';
	}

	/**
	 * Sanitize a dotted tag path segment-by-segment; dots stay as id separators.
	 *
	 * @param name - dotted tag path
	 * @returns the ioBroker-safe object id path
	 */
	sanitizePath(name) {
		return String(name)
			.split('.')
			.filter(p => p)
			.map(p => this.sanitizeSegment(p))
			.join('.');
	}

	/**
	 * ioBroker role + write flag for a tag. Role "value" is never used: the checker
	 * forbids it with write=true and rejects it for boolean (E1011/E1009). EP states
	 * are file-served metadata and stay read-only; live PLC tags stay writable so the
	 * ioBroker→PLC control path keeps working.
	 *
	 * @param iobType - resolved ioBroker common.type
	 * @param isEp - true for file-served extended-property metadata
	 * @returns {{role: string, write: boolean}} the ioBroker role and its write flag
	 */
	roleFor(iobType, isEp) {
		if (isEp) {
			return { role: 'text', write: false };
		}
		switch (iobType) {
			case 'boolean':
				return { role: 'switch', write: true };
			case 'number':
				return { role: 'level', write: true };
			case 'string':
				return { role: 'text', write: true };
			default:
				return { role: 'state', write: true };
		}
	}

	/**
	 * EP states (Label, Description, EngineeringUnit, Navigation, ...) carry file
	 * values: set once from the loaded project model with ack=true — they are
	 * excluded from polling, only changing PLC values travel over EtherNet/IP.
	 */
	async applyEpStates() {
		if (!this.engine) {
			return;
		}
		const eps = (this.config.tags || []).filter(t => (t.type || '').toUpperCase() === 'EP');
		if (eps.length === 0) {
			return;
		}
		const values = JSON.parse(this.engine.getEpValues(JSON.stringify(eps.map(t => t.address || t.name))));
		let applied = 0;
		for (const t of eps) {
			const value = values[t.address || t.name];
			if (value === undefined) {
				continue;
			}
			await this.setState(this.objectIdByName[t.name] || t.name, { val: String(value), ack: true });
			applied++;
		}
		this.log.info(`EP states: ${applied}/${eps.length} served from the project file`);
	}

	/**
	 * PLC projects legitimately create thousands of state objects; lift the
	 * js-controller per-instance objects warning when it sits below what this
	 * configuration needs. A larger user-set value is left untouched.
	 */
	async raiseObjectsWarnLimit() {
		const needed = Math.max(100000, (this.config.tags || []).length * 3);
		const id = `system.adapter.${this.namespace}.objectsWarnLimit`;
		try {
			const cur = await this.getForeignStateAsync(id);
			if (!cur || typeof cur.val !== 'number' || cur.val < needed) {
				await this.setForeignStateAsync(id, { val: needed, ack: true });
				this.log.debug(`objectsWarnLimit raised to ${needed}`);
			}
		} catch (e) {
			this.log.debug(`objectsWarnLimit not raised: ${e.message}`);
		}
	}

	/**
	 * Create the ioBroker object tree for all configured tags (no PLC connection
	 * needed) and (re)build the id routing maps. A tag that has other tags beneath
	 * it is a CHANNEL — its own value, if any, lives in a ".value" child, because a
	 * state must never carry children (E2004). Ids are sanitized (no "@" etc.) and
	 * roles/types follow the checker rules. The engine keeps addressing tags by CIP
	 * path, so `pathToState` bridges path -> object id.
	 */
	async createStateObjects() {
		const tags = this.config.tags || [];
		this.buildingObjects = true; // gate writes/push/engine commands until the tree is ready

		// progress state so the admin (and any dashboard) can show how far the build is
		await this.setObjectNotExistsAsync('info.buildProgress', {
			type: 'state',
			common: {
				name: 'Object build progress',
				type: 'number',
				role: 'value',
				unit: '%',
				read: true,
				write: false,
				def: 0,
			},
			native: {},
		});
		this.setState('info.buildProgress', 0, true);

		// Snapshot the current tree ONCE up front (settled DB, before any writes):
		// reused for both type-change detection and pruning. Reading here — not per
		// tag, and not after the create/delete churn — removes ~2 DB round-trips per
		// object (much faster at 10k+ tags) and avoids the "empty object!" spam that
		// getAdapterObjects logs while the object index is mid-churn.
		const existing = {};
		try {
			// getObjectList scans real keys directly (getKeysViaScan + mget) and silently
			// skips empties. getAdapterObjects/getObjectView instead logs "empty object!"
			// for every stale index row — thousands of them on a large tree.
			const startkey = `${this.namespace}.`;
			const res = await this.getObjectListAsync({ startkey, endkey: startkey + String.fromCharCode(0x9999) });
			const cut = startkey.length;
			for (const row of (res && res.rows) || []) {
				if (row && row.value) {
					existing[row.id.slice(cut)] = row.value;
				}
			}
		} catch (e) {
			this.log.debug(`object snapshot failed: ${e.message}`);
		}

		if (tags.length === 0) {
			this.log.info('No tags configured yet');
			await this.pruneStaleObjects(new Set(), existing); // drop a tree left by a previous config
			this.buildingObjects = false;
			return;
		}

		// A configured tag is a container when another configured tag lives beneath
		// it (dotted prefix). Containers become channels; leaves become states.
		const nameSet = new Set(tags.map(t => t.name));
		const containers = new Set();
		for (const t of tags) {
			const parts = t.name.split('.').filter(p => p);
			let p = '';
			for (let i = 0; i < parts.length - 1; i++) {
				p = p ? `${p}.${parts[i]}` : parts[i];
				if (nameSet.has(p)) {
					containers.add(p);
				}
			}
		}

		// routing maps rebuilt from scratch on every (re)load
		this.pathToState = {}; // CIP path -> object id (engine addresses by path)
		this.tagByObjectId = {}; // object id -> tag config (ioBroker -> PLC write-back)
		this.objectIdByName = {}; // tag.name -> object id (EP apply, subscribe)

		const channelsMade = new Set();
		const desiredIds = new Set();
		const BATCH = 200;
		const progressStep = Math.max(BATCH, Math.ceil(tags.length / 10));
		let created = 0;
		let nextMark = progressStep;

		const ensureChannel = async id => {
			if (channelsMade.has(id)) {
				return;
			}
			channelsMade.add(id);
			const ex = existing[id];
			if (ex) {
				if (ex.type !== 'channel') {
					// upgrade: this id used to be a state (a value that also carried
					// children) — convert it; setObjectNotExists cannot change the type
					const custom = ex.common && ex.common.custom;
					await this.setObjectAsync(id, {
						type: 'channel',
						common: custom ? { name: id.split('.').pop(), custom } : { name: id.split('.').pop() },
						native: {},
					});
				}
				return;
			}
			await this.setObjectNotExistsAsync(id, {
				type: 'channel',
				common: { name: id.split('.').pop() },
				native: {},
			});
		};

		for (let i = 0; i < tags.length; i += BATCH) {
			if (this.terminating) {
				return; // adapter is shutting down — stop touching the DB
			}
			const batch = tags.slice(i, i + BATCH);
			await Promise.all(
				batch.map(async tagConfig => {
					const isEp = (tagConfig.type || '').toUpperCase() === 'EP';
					const iobType = this.getStateType(tagConfig.type);
					const { role, write } = this.roleFor(iobType, isEp);
					const sanit = this.sanitizePath(tagConfig.name);
					const isContainer = containers.has(tagConfig.name);
					// value child leaf; avoid clobbering a real "value" member
					const leaf = nameSet.has(`${tagConfig.name}.value`) ? '_value' : 'value';
					const objectId = isContainer ? `${sanit}.${leaf}` : sanit;

					// channels for every container level (ancestors + this node when it is one)
					const segs = sanit.split('.');
					const levels = isContainer ? segs.length : segs.length - 1;
					let cur = '';
					for (let s = 0; s < levels; s++) {
						cur = cur ? `${cur}.${segs[s]}` : segs[s];
						desiredIds.add(cur);
						await ensureChannel(cur);
					}

					const common = {
						name: objectId.split('.').pop() || objectId,
						type: iobType,
						role,
						read: true,
						write,
						unit: tagConfig.unit || '',
					};
					const native = { tagName: tagConfig.address || tagConfig.name, tagType: tagConfig.type };
					const ex = existing[objectId];
					if (ex && ex.type !== 'state') {
						// a former channel/state-with-children id now becomes the value leaf;
						// extendObject cannot change the type, a full set can
						const keepCustom = ex.common && ex.common.custom;
						await this.setObjectAsync(objectId, {
							type: 'state',
							common: keepCustom ? { ...common, custom: ex.common.custom } : common,
							native,
						});
					} else {
						await this.extendObjectAsync(objectId, { type: 'state', common, native });
					}

					desiredIds.add(objectId);
					this.pathToState[tagConfig.address || tagConfig.name] = objectId;
					this.tagByObjectId[objectId] = tagConfig;
					this.objectIdByName[tagConfig.name] = objectId;
				}),
			).catch(e => {
				// a rejected DB op during shutdown must not become an unhandled rejection
				if (!this.terminating) {
					throw e;
				}
				this.log.debug(`object batch aborted (shutdown): ${e.message}`);
			});
			created += batch.length;
			if (created >= nextMark || created >= tags.length) {
				const pct = Math.round((created / tags.length) * 100);
				this.log.info(`Building objects: ${created}/${tags.length} (${pct}%)`);
				this.setState('info.buildProgress', pct, true);
				nextMark = created + progressStep;
			}
		}

		if (this.terminating) {
			return;
		}
		await this.pruneStaleObjects(desiredIds, existing);
		this.buildingObjects = false;
		this.setState('info.buildProgress', 100, true);
		this.log.info(`Created ${tags.length} ioBroker state objects`);
	}

	/**
	 * Set the ioBroker quality flag on every polled tag state without changing its value,
	 * on a PLC connection transition. 0x42 (not connected) when the link drops so old
	 * values read as stale; 0 (good) when it returns. Reads all states once, then writes
	 * only the ones whose quality actually differs, in batches so a large tree does not
	 * flood the objects DB. Best-effort — never throws into the event loop.
	 *
	 * @param {boolean} stale true when the PLC link dropped (quality 0x42), false when it returned (quality 0)
	 */
	async setAllTagQuality(stale) {
		try {
			if (this.buildingObjects || this.terminating) {
				return;
			}
			const ids = Object.keys(this.tagByObjectId || {});
			if (!ids.length) {
				return;
			}
			const targetQuality = stale ? 0x42 : 0;
			const states = await this.getStatesAsync(`${this.namespace}.*`);
			let changed = 0;
			for (let i = 0; i < ids.length; i += 500) {
				if (this.terminating) {
					return;
				}
				await Promise.all(
					ids.slice(i, i + 500).map(id => {
						const s = states[`${this.namespace}.${id}`];
						if (s && s.val !== null && s.val !== undefined && s.q !== targetQuality) {
							changed++;
							return this.setStateAsync(id, { val: s.val, ack: true, q: stale ? 0x42 : 0 }).catch(
								() => {},
							);
						}
						return null;
					}),
				);
			}
			if (changed) {
				this.log.info(
					stale
						? `PLC disconnected — flagged ${changed} state(s) as stale (not-connected quality)`
						: `PLC reconnected — restored good quality on ${changed} state(s)`,
				);
			}
		} catch (e) {
			this.log.warn(`setAllTagQuality(${stale ? 'stale' : 'good'}): ${e.message}`);
		}
	}

	/**
	 * Delete instance objects (states/channels/folders/devices) that are not part of
	 * the current desired tree — clears the previous, invalid structure on upgrade so
	 * only the valid tree remains. info.* and non-tree objects are always kept.
	 *
	 * @param desiredIds - Set of namespace-relative object ids that must survive
	 * @param existing - snapshot of the current tree (namespace-relative id -> object)
	 */
	async pruneStaleObjects(desiredIds, existing) {
		const all = existing || {};
		const dels = [];
		for (const id of Object.keys(all)) {
			if (id === 'info' || id.startsWith('info.')) {
				continue;
			}
			const type = all[id] && all[id].type;
			if (type !== 'state' && type !== 'channel' && type !== 'folder' && type !== 'device') {
				continue;
			}
			if (!desiredIds.has(id) && !this.terminating) {
				dels.push(this.delObjectAsync(id).catch(() => {}));
			}
		}
		if (dels.length) {
			await Promise.all(dels).catch(() => {});
			this.log.info(`Removed ${dels.length} stale object(s) from the previous structure`);
		}
	}

	/**
	 * Subscribe to all configured states so ioBroker→PLC writes are received.
	 */
	subscribeConfiguredStates() {
		this.unsubscribeStates('*');
		const tags = this.config.tags || [];
		for (const tag of tags) {
			this.subscribeStates((this.objectIdByName && this.objectIdByName[tag.name]) || tag.name);
		}
		this.log.debug(`Subscribed to ${tags.length} configured states for write-back`);
	}

	/**
	 * Get ioBroker state type from PLC tag type
	 *
	 * @param tagType - Logix data type, e.g. DINT / REAL / BOOL / STRING
	 * @returns {ioBroker.CommonType} the ioBroker common.type
	 */
	getStateType(tagType) {
		if (!tagType) {
			return 'mixed';
		}

		const type = tagType.toUpperCase();
		if (type === 'EP') {
			return 'string'; // file-served extended property
		}
		if (type.includes('BOOL')) {
			return 'boolean';
		}
		if (type.includes('INT') || type.includes('DINT') || type.includes('REAL')) {
			return 'number';
		}
		if (type.includes('STRING')) {
			return 'string';
		}
		return 'mixed';
	}

	/**
	 * Coerce an engine-supplied value to the state's declared ioBroker type so
	 * js-controller does not reject it with a type warning — e.g. a USINT arrives
	 * as the numeric string "65" for a number state.
	 *
	 * @param val - value from the engine change event
	 * @param iobType - the state's ioBroker common.type
	 * @returns {any} the value coerced to iobType where it is safe to do so
	 */
	coerceValue(val, iobType) {
		if (val === null || val === undefined) {
			return val;
		}
		if (iobType === 'number' && typeof val !== 'number') {
			const n = Number(val);
			return Number.isNaN(n) ? val : n;
		}
		if (iobType === 'boolean' && typeof val !== 'boolean') {
			return val === true || val === 1 || val === '1' || val === 'true';
		}
		if (iobType === 'string' && typeof val !== 'string') {
			return String(val);
		}
		return val;
	}

	/**
	 * Is called if a subscribed state changes: ioBroker → PLC write through the engine.
	 *
	 * @param {string} id - State ID
	 * @param {ioBroker.State | null | undefined} state - State object
	 */
	async onStateChange(id, state) {
		if (!state || state.ack || this.buildingObjects || this.terminating) {
			return;
		}

		const stateId = id.replace(`${this.namespace}.`, '');
		if (stateId.startsWith('info.')) {
			return;
		}

		const tagConfig = (this.tagByObjectId || {})[stateId];
		if (!tagConfig || !this.engine) {
			return;
		}
		if ((tagConfig.type || '').toUpperCase() === 'EP') {
			return; // file metadata — nothing to write to the PLC
		}

		const plcPath = tagConfig.address || tagConfig.name;
		let result;
		try {
			result = JSON.parse(this.engine.write(plcPath, JSON.stringify(state.val)));
		} catch (e) {
			this.log.error(`Error writing to tag ${plcPath}: ${e.message}`);
			return;
		}
		if (result.ok) {
			const fromAdapter = (state.from || '').replace('system.adapter.', '');
			this.log.info(`Wrote ${state.val} to PLC tag ${plcPath} [from: ${fromAdapter}]`);
			await this.setState(stateId, { val: state.val, ack: true });
		} else {
			this.log.error(`Error writing to tag ${plcPath}: ${result.error}`);
		}
	}

	/**
	 * engine.parseProject → admin response ({success, tags, stats}) — wire-compatible
	 * with the retired JS L5K parser flow.
	 *
	 * @param content - raw project file text
	 * @param format - 'l5k' or 'l5x'
	 * @returns the admin response payload
	 */
	parseProjectForAdmin(content, format) {
		const parsed = JSON.parse(this.engine.parseProject(content, format));
		const tags = parsed.tags || [];
		const programs = new Set(tags.filter(t => (t.group || '').startsWith('Program: ')).map(t => t.group));
		return {
			success: true,
			tags,
			stats: {
				controllerTags: parsed.tagCount,
				programs: programs.size,
				dataTypes: parsed.dataTypeCount,
				alarmTags: parsed.alarmTagCount,
			},
		};
	}

	/**
	 * Some message was sent to this instance over message box
	 *
	 * @param {ioBroker.Message} obj - Message object
	 */
	async onMessage(obj) {
		if (typeof obj !== 'object' || !obj.command) {
			return;
		}
		const respond = payload => {
			if (obj.callback) {
				this.sendTo(obj.from, obj.command, payload, obj.callback);
			}
		};

		// engine-dependent commands would race an in-progress (re)build — answer busy
		if (this.buildingObjects && ['testConnection', 'browseController', 'getAlarms'].includes(obj.command)) {
			return respond({ success: false, error: 'busy building objects' });
		}

		try {
			switch (obj.command) {
				case 'browseTags': {
					// Model-based browse from the configured project file (live browse: Phase 6)
					if (!this.engine) {
						return respond({ success: false, error: 'engine not loaded' });
					}
					const file = this.config.projectFile;
					if (!file || !fs.existsSync(file)) {
						return respond({ success: false, error: 'configure projectFile to browse tags' });
					}
					const format = file.toLowerCase().endsWith('.l5x') ? 'l5x' : 'l5k';
					return respond(this.parseProjectForAdmin(fs.readFileSync(file, 'utf8'), format));
				}
				case 'importTags': {
					// Bulk tag-config import from a JSON file in the instance data dir —
					// the message bus cannot carry a 12k-tag array, a file can.
					const file = resolveProjectFile(
						utils.getAbsoluteInstanceDataDir(this),
						obj.message && obj.message.path,
					);
					const imported = JSON.parse(fs.readFileSync(file, 'utf8'));
					if (!Array.isArray(imported)) {
						return respond({ success: false, error: 'file must contain a tag array' });
					}
					this.log.info(`importTags: applying ${imported.length} tags from ${file} (adapter will restart)`);
					respond({ success: true, count: imported.length });
					await this.updateConfig({ tags: imported });
					return;
				}
				case 'deleteObjects': {
					// Bulk state-object removal for the admin: one recursive delete per
					// subtree root instead of one socket round trip per object (the old
					// per-object path took minutes for a 600-tag group and looked dead).
					const ids = (obj.message && obj.message.ids) || [];
					if (!Array.isArray(ids) || !ids.length) {
						return respond({ success: false, error: 'ids required' });
					}
					respond({ success: true, count: ids.length }); // config already updated — don't block the UI
					for (const id of ids) {
						try {
							await this.delObjectAsync(id, { recursive: true });
						} catch (e) {
							this.log.debug(`deleteObjects ${id}: ${e.message}`);
						}
					}
					this.log.info(`deleteObjects: removed ${ids.length} subtree(s)`);
					return;
				}
				case 'generatePushProgram': {
					// Build the partial-import L5X for the current push selection.
					if (!this.engine) {
						return respond({ success: false, error: 'engine not loaded' });
					}
					const hostIp = (obj.message && obj.message.hostIp) || '';
					if (!hostIp) {
						return respond({ success: false, error: 'hostIp required' });
					}
					const l5x = this.engine.generatePushL5x(hostIp);
					if (l5x.startsWith('{')) {
						return respond({ success: false, error: JSON.parse(l5x).error || 'generation failed' });
					}
					return respond({ success: true, l5x });
				}
				case 'browseController': {
					// Live symbol-list browse over EtherNet/IP — no project file needed.
					if (!this.engine) {
						return respond({ success: false, error: 'engine not loaded' });
					}
					const parsed = JSON.parse(this.engine.browseController());
					if (parsed.error) {
						return respond({ success: false, error: parsed.error });
					}
					const liveTags = parsed.tags || [];
					const livePrograms = new Set(
						liveTags.filter(t => (t.group || '').startsWith('Program: ')).map(t => t.group),
					);
					return respond({
						success: true,
						tags: liveTags,
						stats: {
							controllerTags: parsed.tagCount,
							programs: livePrograms.size,
							dataTypes: 0,
							alarmTags: 0,
						},
					});
				}
				case 'testConnection': {
					if (!this.engine) {
						return respond({ success: false, connected: false, error: 'engine not loaded' });
					}
					try {
						let stats = {};
						try {
							stats = JSON.parse(this.engine.getStats());
						} catch {
							/* stats are best-effort */
						}
						// Report the engine's live connection state (mirrored into
						// info.connection) rather than reading one arbitrary tag: the old
						// blocking read could leave the message unanswered (button hangs),
						// and a non-"Good" first tag reported "not connected" even while the
						// PLC was online.
						const conn = await this.getStateAsync('info.connection').catch(() => null);
						const connected = !!(conn && conn.val);
						return respond({ success: connected, connected, stats });
					} catch (e) {
						return respond({ success: false, connected: false, error: e.message });
					}
				}
				case 'reloadTags': {
					respond({ success: true }); // reply first so the browser does not block
					const { tags } = obj.message || {};
					if (!tags) {
						return;
					}
					this.config.tags = tags;
					try {
						await this.createStateObjects();
						this.subscribeConfiguredStates();
						this.restartEngine();
						this.log.info(`reloadTags: ${tags.length} tags reloaded`);
					} catch (e) {
						this.log.error(`reloadTags background error: ${e.message}`);
					}
					return;
				}
				case 'parseL5K': {
					if (!this.engine) {
						return respond({ success: false, error: 'engine not loaded' });
					}
					const { fileContent } = obj.message || {};
					if (!fileContent) {
						throw new Error('No file content provided');
					}
					return respond(this.parseProjectForAdmin(fileContent, 'l5k'));
				}
				case 'parseProject': {
					if (!this.engine) {
						return respond({ success: false, error: 'engine not loaded' });
					}
					const { content, format } = obj.message || {};
					if (!content) {
						throw new Error('No content provided');
					}
					return respond(this.parseProjectForAdmin(content, format === 'l5x' ? 'l5x' : 'l5k'));
				}
				case 'parseProjectPath': {
					// Parse a previously saved project file from disk — the file content
					// never crosses the message bus (22 MB L5X exceeds its size limit).
					if (!this.engine) {
						return respond({ success: false, error: 'engine not loaded' });
					}
					const { path: requestedPath, format } = obj.message || {};
					const file = resolveProjectFile(utils.getAbsoluteInstanceDataDir(this), requestedPath);
					// The saved file's extension is ground truth — a client format hint must
					// not send L5K text into the XML parser (admin selector can be stale).
					const lower = file.toLowerCase();
					const fmt = lower.endsWith('.l5x')
						? 'l5x'
						: lower.endsWith('.l5k')
							? 'l5k'
							: format === 'l5x'
								? 'l5x'
								: 'l5k';
					return respond(this.parseProjectForAdmin(fs.readFileSync(file, 'utf8'), fmt));
				}
				case 'readValues': {
					if (!this.engine) {
						return respond({ success: false, error: 'engine not loaded' });
					}
					const { paths } = obj.message || {};
					const values = JSON.parse(this.engine.read(JSON.stringify(paths || [])));
					return respond({ success: true, values });
				}
				case 'leaseTags': {
					if (!this.engine) {
						return respond({ success: false, error: 'engine not loaded' });
					}
					const { paths, ttlMs } = obj.message || {};
					this.engine.lease(JSON.stringify(paths || []), ttlMs || 60000);
					return respond({ success: true });
				}
				case 'getAlarms': {
					if (!this.engine) {
						return respond({ success: false, error: 'engine not loaded' });
					}
					const { tag } = obj.message || {};
					const alarms = JSON.parse(this.engine.getAlarms(tag || ''));
					return respond({ success: true, alarms });
				}
				case 'getStats': {
					if (!this.engine) {
						return respond({ success: false, error: 'engine not loaded' });
					}
					return respond({ success: true, stats: JSON.parse(this.engine.getStats()) });
				}
				case 'getLicenseInfo': {
					// works before the engine is started — the admin UI needs the hardware ID
					const eng = this.engine || load(this.log);
					const key =
						obj.message && typeof obj.message.licenseKey === 'string'
							? obj.message.licenseKey
							: this.config.licenseKey || '';
					return respond({ success: true, ...JSON.parse(eng.getLicenseInfo(key)) });
				}
				case 'saveProjectFile': {
					// Accepts either the whole file ({name, content}) or 1 MB slices
					// ({name, content, seq, total}) — 22 MB L5X exceeds the bus limit in one message.
					const { name, content, seq, total } = obj.message || {};
					const dir = utils.getAbsoluteInstanceDataDir(this);
					fs.mkdirSync(dir, { recursive: true });
					const result = writeProjectChunk(dir, name, content, seq, total);
					if (result.done) {
						this.log.info(`saveProjectFile: stored ${result.path}`);
					}
					return respond({ success: true, path: result.path, done: result.done });
				}
				default:
					return respond({ success: false, error: `unknown command '${obj.command}'` });
			}
		} catch (e) {
			this.log.error(`${obj.command} failed: ${e.message}`);
			respond({ success: false, error: e.message });
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param {() => void} callback - Callback function
	 */
	onUnload(callback) {
		this.terminating = true;
		try {
			if (this.watchdog) {
				this.clearInterval(this.watchdog);
				this.watchdog = null;
			}
			if (this.engine) {
				this.engine.stop();
				this.engine = null;
			}
			callback();
		} catch (error) {
			this.log.error(`Error during unloading: ${error.message}`);
			callback();
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	module.exports = options => new RockwellEthernetip(options);
} else {
	// otherwise start the instance directly
	new RockwellEthernetip();
}
