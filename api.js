/*
 * Pollinations API layer for the Figma plug-in. Pure JavaScript, no build step.
 * Runs both in the plug-in UI iframe (window.Pollinations) and in Node
 * (module.exports) so the exact request/response code is unit-testable.
 */
(function (root, factory) {
	const api = factory(root);
	if (typeof module === "object" && module.exports) module.exports = api;
	root.Pollinations = api;
})(typeof self !== "undefined" ? self : globalThis, function (root) {
	"use strict";

	const GENERATION_URL = "https://gen.pollinations.ai";
	const AUTH_URL = "https://enter.pollinations.ai";
	const JSON_HEADERS = { "Content-Type": "application/json" };
	const DEFAULT_IMAGE_MODEL = "tongyi-mai/z-image-turbo";
	const DEFAULT_EDIT_MODEL = "openai/gpt-image-2";

	function bytesFromBase64(b64) {
		if (typeof atob === "function") {
			const binary = atob(b64);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			return bytes;
		}
		return new Uint8Array(Buffer.from(b64, "base64"));
	}

	function base64FromBytes(bytes) {
		if (typeof btoa === "function") {
			let binary = "";
			for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
			return btoa(binary);
		}
		return Buffer.from(bytes).toString("base64");
	}

	function buildGenerateBody(model, prompt, resolution) {
		const body = { model: model, prompt: prompt, response_format: "b64_json" };
		if (resolution) body.resolution = resolution;
		return JSON.stringify(body);
	}

	function buildEditBody(model, prompt, pngBase64, resolution) {
		const body = {
			model: model,
			prompt: prompt,
			image: "data:image/png;base64," + pngBase64,
			response_format: "b64_json"
		};
		if (resolution) body.resolution = resolution;
		return JSON.stringify(body);
	}

	/* Mirrors the official GIMP plug-in: image output, no video models. */
	function filterImageModels(catalog) {
		if (!Array.isArray(catalog)) throw new Error("Invalid model catalog.");
		return catalog.filter(function (m) {
			return m && typeof m.name === "string"
				&& m.output_modalities && m.output_modalities.indexOf("image") !== -1
				&& m.output_modalities.indexOf("video") === -1;
		});
	}

	function supportsImageInput(model) {
		return Boolean(model && model.input_modalities && model.input_modalities.indexOf("image") !== -1);
	}

	function parseImageResponse(text) {
		let data = null;
		try {
			data = JSON.parse(text);
		} catch (parseError) {
			throw new Error("The response was not valid JSON.");
		}
		const item = data && Array.isArray(data.data) ? data.data[0] : null;
		const b64 = item && typeof item.b64_json === "string" ? item.b64_json : "";
		if (!b64) throw new Error("Generation returned no valid image. Check your account activity before retrying.");
		const bytes = bytesFromBase64(b64);
		if (!bytes.length) throw new Error("Generation returned an empty image.");
		return bytes;
	}

	function friendlyError(status, bodyText) {
		let message = "Pollinations request failed (HTTP " + status + ")";
		try {
			const parsed = JSON.parse(bodyText);
			if (parsed && parsed.error && parsed.error.message) message = parsed.error.message;
		} catch (parseError) { /* not JSON */ }
		if (status === 402 || /insufficient/i.test(message)) {
			message += " - your Pollen balance is too low. Top up at https://enter.pollinations.ai/top-up";
		}
		if (status === 401) {
			message += " - sign in with the device flow or set a development API key in the Account tab";
		}
		return message;
	}

	function deviceStep(body) {
		if (body && typeof body.access_token === "string" && body.access_token) {
			return { type: "granted", accessToken: body.access_token };
		}
		const error = body && typeof body.error === "string" ? body.error : "unknown";
		if (error === "authorization_pending") return { type: "pending" };
		if (error === "slow_down") return { type: "slow_down" };
		return { type: "fail", error: error };
	}

	/* BYOP device flow. `request(options) -> {status, text}` is injected. */
	async function deviceFlow(options) {
		const request = options.request;
		const openUrl = options.openUrl || null;
		const onCode = options.onCode || null;
		const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		const codeRes = await request({
			url: AUTH_URL + "/api/device/code",
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ client_id: options.appKey })
		});
		if (codeRes.status >= 400) throw new Error(friendlyError(codeRes.status, codeRes.text));
		let code = null;
		try {
			code = JSON.parse(codeRes.text);
		} catch (parseError) {
			throw new Error(friendlyError(codeRes.status, codeRes.text));
		}
		if (!code || typeof code.device_code !== "string" || !code.device_code) {
			throw new Error("The device flow returned no device_code.");
		}
		/* The approval URL must stay on enter.pollinations.ai (host check, as in the
		 * official GIMP plug-in). */
		let approvalUrl = typeof code.verification_uri_complete === "string" && code.verification_uri_complete
			? code.verification_uri_complete
			: code.verification_uri;
		if (!/^https?:\/\/([a-z0-9-]+\.)*pollinations\.ai\//i.test(approvalUrl || "")) {
			throw new Error("Unexpected approval URL: " + approvalUrl);
		}
		if (onCode) onCode(String(code.user_code || ""), approvalUrl);
		if (openUrl) openUrl(approvalUrl);
		let interval = typeof code.interval === "number" && code.interval > 0 ? code.interval : 5;
		const deadline = Date.now() + (typeof code.expires_in === "number" && code.expires_in > 0 ? code.expires_in * 1000 : 600000);
		for (;;) {
			if (Date.now() >= deadline) return { granted: false, error: "expired_token" };
			await sleep(interval * 1000);
			const tokenRes = await request({
				url: AUTH_URL + "/api/device/token",
				method: "POST",
				headers: JSON_HEADERS,
				body: JSON.stringify({ client_id: options.appKey, device_code: code.device_code })
			});
			let body = null;
			try {
				body = JSON.parse(tokenRes.text);
			} catch (parseError) {
				throw new Error(friendlyError(tokenRes.status, tokenRes.text));
			}
			/* Pending/denied/expired arrive as HTTP 400 with a JSON error body. */
			const step = deviceStep(body);
			if (step.type === "granted") return { granted: true, accessToken: step.accessToken };
			if (step.type === "pending") continue;
			if (step.type === "slow_down") { interval += 5; continue; }
			return { granted: false, error: step.error };
		}
	}

	class PollinationsClient {
		constructor(transport, getToken) {
			this.transport = transport;
			this.getToken = getToken || (function () { return ""; });
		}

		async _post(path, body) {
			const headers = Object.assign({}, JSON_HEADERS);
			const token = this.getToken();
			if (token) headers["Authorization"] = "Bearer " + token;
			const res = await this.transport({ url: GENERATION_URL + path, method: "POST", headers: headers, body: body });
			if (res.status >= 400) throw new Error(friendlyError(res.status, res.text));
			return res.text;
		}

		async imageModels() {
			const headers = {};
			const token = this.getToken();
			if (token) headers["Authorization"] = "Bearer " + token;
			const res = await this.transport({ url: GENERATION_URL + "/image/models", method: "GET", headers: headers });
			if (res.status >= 400) throw new Error(friendlyError(res.status, res.text));
			return filterImageModels(JSON.parse(res.text));
		}

		async generateImage(prompt, model, resolution) {
			return parseImageResponse(await this._post("/v1/images/generations", buildGenerateBody(model, prompt, resolution)));
		}

		async editImage(prompt, model, pngBase64, resolution) {
			return parseImageResponse(await this._post("/v1/images/edits", buildEditBody(model, prompt, pngBase64, resolution)));
		}
	}

	return {
		GENERATION_URL: GENERATION_URL,
		AUTH_URL: AUTH_URL,
		DEFAULT_IMAGE_MODEL: DEFAULT_IMAGE_MODEL,
		DEFAULT_EDIT_MODEL: DEFAULT_EDIT_MODEL,
		bytesFromBase64: bytesFromBase64,
		base64FromBytes: base64FromBytes,
		buildGenerateBody: buildGenerateBody,
		buildEditBody: buildEditBody,
		filterImageModels: filterImageModels,
		supportsImageInput: supportsImageInput,
		parseImageResponse: parseImageResponse,
		friendlyError: friendlyError,
		deviceStep: deviceStep,
		deviceFlow: deviceFlow,
		PollinationsClient: PollinationsClient
	};
});
