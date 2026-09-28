"use strict";
/* Unit + integration suite. api.js runs as a Node module; code.js runs against
 * a mocked `figma` global. No Figma needed. Run: npm test */

let failures = 0, checks = 0;
function check(condition, name) {
	checks += 1;
	console.log((condition ? "[ok] " : "[FAIL] ") + name);
	if (!condition) failures += 1;
}
function eq(a, b, name) { check(JSON.stringify(a) === JSON.stringify(b), name + " (" + JSON.stringify(a) + ")"); }

const api = require("../api.js");

/* ---- pure helpers ---- */
eq(JSON.parse(api.buildGenerateBody("tongyi-mai/z-image-turbo", "a cat", undefined)),
	{ model: "tongyi-mai/z-image-turbo", prompt: "a cat", response_format: "b64_json" }, "buildGenerateBody shape");
eq(JSON.parse(api.buildGenerateBody("m", "p", "2k")).resolution, "2k", "buildGenerateBody resolution");
const editBody = JSON.parse(api.buildEditBody("openai/gpt-image-2", "make it red", "QUJD"));
eq(editBody, { model: "openai/gpt-image-2", prompt: "make it red", image: "data:image/png;base64,QUJD", response_format: "b64_json" }, "buildEditBody data-URI shape");

const catalog = [
	{ name: "tongyi-mai/z-image-turbo", input_modalities: ["text"], output_modalities: ["image"] },
	{ name: "minimax/minimax-h3", input_modalities: ["text"], output_modalities: ["image", "video"] },
	{ name: "openai/gpt-image-2", input_modalities: ["text", "image"], output_modalities: ["image"] },
	{ name: "not-a-model" }
];
const filtered = api.filterImageModels(catalog);
eq(filtered.map(m => m.name), ["tongyi-mai/z-image-turbo", "openai/gpt-image-2"], "filterImageModels drops video + junk");
check(api.supportsImageInput(filtered[1]) && !api.supportsImageInput(filtered[0]), "supportsImageInput");

const tinyJpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x02]);
eq(Array.from(api.parseImageResponse(JSON.stringify({ data: [{ b64_json: Buffer.from(tinyJpeg).toString("base64") }] }))),
	Array.from(tinyJpeg), "parseImageResponse decodes b64_json");
let threwEmpty = false;
try { api.parseImageResponse(JSON.stringify({ data: [{ b64_json: "" }] })); } catch (e) { threwEmpty = true; }
check(threwEmpty, "parseImageResponse rejects empty images");

const e402 = api.friendlyError(402, JSON.stringify({ error: { message: "Insufficient balance." } }));
check(/Pollen balance/.test(e402), "friendlyError 402 top-up hint");
const e401 = api.friendlyError(401, JSON.stringify({ error: { message: "A valid API key is required." } }));
check(/device flow/.test(e401), "friendlyError 401 sign-in hint");

eq(api.deviceStep({ access_token: "t" }), { type: "granted", accessToken: "t" }, "deviceStep granted");
eq(api.deviceStep({ error: "authorization_pending" }), { type: "pending" }, "deviceStep pending");
eq(api.deviceStep({ error: "slow_down" }), { type: "slow_down" }, "deviceStep slow_down");
eq(api.deviceStep({ error: "access_denied" }), { type: "fail", error: "access_denied" }, "deviceStep denied");

/* ---- deviceFlow: pending arrives as HTTP 400 (real shape), approval URL host-checked ---- */
async function testDeviceFlow() {
	const seen = { open: [], code: [], tokenBodies: [] };
	let polls = 0;
	const request = async (options) => {
		if (options.url.endsWith("/api/device/code")) {
			return { status: 200, text: JSON.stringify({
				device_code: "dc", user_code: "CODE-1234",
				verification_uri: "https://enter.pollinations.ai/device",
				verification_uri_complete: "https://enter.pollinations.ai/device?user_code=CODE-1234",
				interval: 5, expires_in: 600 }) };
		}
		seen.tokenBodies.push(JSON.parse(options.body));
		polls += 1;
		if (polls === 1) return { status: 400, text: JSON.stringify({ error: "authorization_pending" }) };
		return { status: 200, text: JSON.stringify({ access_token: "sk_dev" }) };
	};
	const result = await api.deviceFlow({
		appKey: "pk_test", request: request,
		openUrl: (url) => seen.open.push(url),
		onCode: (code, url) => seen.code.push([code, url]),
		sleep: async () => {}
	});
	check(result.granted && result.accessToken === "sk_dev", "deviceFlow grants after a 400 pending");
	check(seen.open[0] === "https://enter.pollinations.ai/device?user_code=CODE-1234", "deviceFlow opens verification_uri_complete");
	check(seen.code[0][0] === "CODE-1234", "deviceFlow surfaces the user code");
	check(seen.tokenBodies[0].client_id === "pk_test" && seen.tokenBodies[0].device_code === "dc", "deviceFlow polls with client_id + device_code");

	let threwHost = false;
	try {
		await api.deviceFlow({
			appKey: "pk_test",
			request: async () => ({ status: 200, text: JSON.stringify({ device_code: "dc", verification_uri: "https://evil.example/device" }) }),
			sleep: async () => {}
		});
	} catch (e) { threwHost = true; }
	check(threwHost, "deviceFlow rejects approval URLs on other hosts");
}

/* ---- client with mocked transport ---- */
async function testClient() {
	const calls = [];
	const transport = async (options) => {
		calls.push(options);
		if (options.url.endsWith("/image/models")) {
			return { status: 200, text: JSON.stringify(catalog) };
		}
		if (options.url.endsWith("/v1/images/generations")) {
			return { status: 200, text: JSON.stringify({ data: [{ b64_json: Buffer.from(tinyJpeg).toString("base64") }] }) };
		}
		if (options.url.endsWith("/v1/images/edits")) {
			return { status: 200, text: JSON.stringify({ data: [{ b64_json: Buffer.from(tinyJpeg).toString("base64") }] }) };
		}
		return { status: 404, text: "{}" };
	};
	const c = new api.PollinationsClient(transport, () => "sk_key");
	const models = await c.imageModels();
	check(models.length === 2, "client.imageModels filters the catalog");
	const gen = await c.generateImage("a cat", "tongyi-mai/z-image-turbo");
	check(gen.length === 6, "client.generateImage returns decoded bytes");
	check(calls.find(x => x.url.includes("generations")).headers["Authorization"] === "Bearer sk_key", "client sends the Bearer token");
	const edited = await c.editImage("make it red", "openai/gpt-image-2", "QUJD");
	check(edited.length === 6, "client.editImage returns decoded bytes");
	const body = JSON.parse(calls.find(x => x.url.includes("edits")).body);
	check(body.image.startsWith("data:image/png;base64,"), "client.editImage posts a PNG data URI");
}

/* ---- code.js integration against a mocked figma ---- */
async function testSandbox() {
	const messages = [];
	const notices = [];
	const storage = {};
	const createdImages = [];
	const exported = [];
	const node = {
		id: "10:5", name: "Hero", width: 800, height: 600, fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }],
		exportAsync: async () => { const bytes = Uint8Array.from([1, 2, 3, 4]); exported.push(bytes); return bytes; }
	};
	global.__html__ = "<html>ui</html>";
	global.figma = {
		showUI: (html) => { global.__shown_html__ = typeof html === "string" && html.length > 0; },
		ui: {
			postMessage: (m) => messages.push(m),
			onmessage: null
		},
		currentPage: { selection: [node] },
		clientStorage: {
			getAsync: async (k) => storage[k],
			setAsync: async (k, v) => { storage[k] = v; }
		},
		on: () => {},
		getNodeByIdAsync: async (id) => (id === "10:5" ? node : null),
		createImage: async (bytes) => { createdImages.push(bytes); return { hash: "H" + bytes.length }; },
		notify: (m) => notices.push(m),
		closePlugin: () => {}
	};
	require("../code.js");
	check(global.__shown_html__ === true, "code.js shows the UI");

	await global.figma.ui.onmessage({ type: "get-selection" });
	check(messages.some(m => m.type === "selection" && m.nodes[0].supportsFill === true && m.nodes[0].exportable === true),
		"sandbox reports fill/export capability of the selection");

	await global.figma.ui.onmessage({ type: "store-auth", token: "sk_device", apiKey: "" });
	check(storage["pollinations.token"] === "sk_device", "sandbox stores the token in clientStorage");
	check(messages.some(m => m.type === "auth" && m.token === "sk_device"), "sandbox confirms auth back to the UI");

	await global.figma.ui.onmessage({ type: "request-edit-source", nodeId: "10:5" });
	check(exported.length === 1 && messages.some(m => m.type === "edit-source" && m.nodeId === "10:5"),
		"sandbox exports the selection as PNG and sends it to the UI");

	await global.figma.ui.onmessage({ type: "apply-fill", nodeId: "10:5", bytes: Uint8Array.from([9, 9, 9]) });
	check(node.fills.length === 1 && node.fills[0].type === "IMAGE" && node.fills[0].imageHash === "H3" && node.fills[0].scaleMode === "FILL",
		"sandbox replaces fills with the generated IMAGE paint");

	await global.figma.ui.onmessage({ type: "apply-fill", nodeId: "99:1", bytes: Uint8Array.from([1]) });
	check(notices.some(n => /no longer exists/.test(n)), "sandbox notices a missing layer");

	await global.figma.ui.onmessage({ type: "notify", message: "from ui" });
	check(notices.includes("from ui"), "sandbox relays notifications");
}

async function main() {
	await testDeviceFlow();
	await testClient();
	await testSandbox();
	console.log("RESULT: " + (failures === 0 ? "PASS" : "FAIL") + " (" + failures + " failures, " + checks + " checks)");
	process.exit(failures === 0 ? 0 : 1);
}
main();
