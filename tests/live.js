"use strict";
/* Live verification: the plug-in's own api.js code against the real Pollinations
 * API. Uses POLLINATIONS_API_KEY when present; otherwise exits with an explicit
 * skip. Run: npm run test:live */

const fs = require("fs");
const api = require("../api.js");

const KEY = process.env.POLLINATIONS_API_KEY || "";
let failures = 0;
function check(condition, name) {
	console.log((condition ? "[ok] " : "[FAIL] ") + name);
	if (!condition) failures += 1;
}
async function transport(options) {
	const headers = Object.assign({}, options.headers || {});
	const res = await fetch(options.url, { method: options.method || "GET", headers: headers, body: options.body || undefined });
	const bytes = new Uint8Array(await res.arrayBuffer());
	return { status: res.status, text: new TextDecoder().decode(bytes), bytes: bytes };
}

async function main() {
	if (!KEY) {
		console.log("[skip] live checks (no POLLINATIONS_API_KEY in the environment)");
		return;
	}
	const client = new api.PollinationsClient(transport, () => KEY);

	const models = await client.imageModels();
	check(models.length > 10, "live image model catalog loads and filters (" + models.length + " image models)");
	check(models.some(m => m.name === api.DEFAULT_IMAGE_MODEL), "catalog includes the default generate model");
	check(models.some(m => m.name === api.DEFAULT_EDIT_MODEL), "catalog includes the default edit model");

	const generated = await client.generateImage("a tiny pixel-art garden on an alien planet", api.DEFAULT_IMAGE_MODEL);
	check(generated.length > 10000 && generated[0] === 0xff && generated[1] === 0xd8, "live generation decoded a " + generated.length + "-byte JPEG via b64_json");

	const png = new Uint8Array(fs.readFileSync("tests/assets/source.png"));
	const pngB64 = Buffer.from(png).toString("base64");
	try {
		const edited = await client.editImage("replace the background with a night sky", api.DEFAULT_EDIT_MODEL, pngB64);
		check(edited.length > 1000, "live edit via /v1/images/edits decoded a " + edited.length + "-byte image");
	} catch (error) {
		const message = String(error.message || error);
		if (/Insufficient|402|balance/i.test(message)) {
			console.log("[skip] live edit (account balance does not cover this edit model)");
		} else {
			check(false, "live edit via /v1/images/edits failed: " + message);
		}
	}
	console.log("RESULT: " + (failures === 0 ? "PASS" : "FAIL") + " (" + failures + " failures)");
	process.exit(failures === 0 ? 0 : 1);
}
main();
