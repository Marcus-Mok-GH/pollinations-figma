/*
 * Pollinations for Figma - sandbox side. All API traffic happens in ui.html;
 * this file only handles canvas work, selection state, and secure storage of
 * the token/API key in figma.clientStorage (never in the document).
 */

figma.showUI(__html__, { width: 360, height: 480, themeColors: true });

const CLIENT_STORAGE_KEYS = { token: "pollinations.token", apiKey: "pollinations.apiKey" };

function nodeSupportsFill(node) {
	return node && node.fills !== undefined && typeof node.setRelaunchButton !== "function";
}

function selectionSummary() {
	return figma.currentPage.selection.map(function (node) {
		return {
			id: node.id,
			name: node.name,
			width: Math.round(node.width),
			height: Math.round(node.height),
			supportsFill: nodeSupportsFill(node),
			exportable: typeof node.exportAsync === "function"
		};
	});
}

function sendSelection() {
	figma.ui.postMessage({ type: "selection", nodes: selectionSummary() });
}

async function sendAuth() {
	const token = await figma.clientStorage.getAsync(CLIENT_STORAGE_KEYS.token);
	const apiKey = await figma.clientStorage.getAsync(CLIENT_STORAGE_KEYS.apiKey);
	figma.ui.postMessage({ type: "auth", token: token || "", apiKey: apiKey || "" });
}

async function applyFill(message) {
	const node = await figma.getNodeByIdAsync(message.nodeId);
	if (!node) {
		figma.notify("That layer no longer exists");
		return;
	}
	if (!nodeSupportsFill(node)) {
		figma.notify("Select a frame, rectangle, or shape to fill");
		return;
	}
	let image = null;
	try {
		image = await figma.createImage(message.bytes);
	} catch (createError) {
		figma.notify("The generated image could not be decoded");
		return;
	}
	node.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: image.hash }];
	figma.notify("Filled " + node.name + " with the generated image");
	figma.ui.postMessage({ type: "busy", busy: false });
}

async function sendEditSource(message) {
	const node = await figma.getNodeByIdAsync(message.nodeId);
	if (!node) {
		figma.notify("That layer no longer exists");
		return;
	}
	if (typeof node.exportAsync !== "function") {
		figma.notify("The selected layer cannot be exported as an image");
		return;
	}
	const bytes = await node.exportAsync({ format: "PNG" });
	figma.ui.postMessage({ type: "edit-source", nodeId: node.id, bytes: bytes });
}

figma.on("selectionchange", sendSelection);

figma.ui.onmessage = async function (message) {
	if (!message || typeof message.type !== "string") return;
	if (message.type === "get-selection") {
		sendSelection();
	} else if (message.type === "get-auth") {
		await sendAuth();
	} else if (message.type === "store-auth") {
		await figma.clientStorage.setAsync(CLIENT_STORAGE_KEYS.token, message.token || "");
		await figma.clientStorage.setAsync(CLIENT_STORAGE_KEYS.apiKey, message.apiKey || "");
		figma.notify(message.token || message.apiKey ? "Pollinations connected" : "Pollinations disconnected");
		await sendAuth();
	} else if (message.type === "apply-fill") {
		await applyFill(message);
	} else if (message.type === "request-edit-source") {
		await sendEditSource(message);
	} else if (message.type === "notify") {
		figma.notify(message.message);
	}
};
