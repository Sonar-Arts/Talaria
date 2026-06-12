import * as http from "http";
import * as https from "https";
import type { ChatMessage } from "../types";

export interface ChatCompletionOptions {
	baseUrl: string;
	apiKey?: string;
	model: string;
	messages: ChatMessage[];
	temperature: number;
	stream: boolean;
	maxTokens?: number;
	onToken?: (token: string) => void;
	signal?: AbortSignal;
}

/**
 * Minimal OpenAI-compatible /chat/completions client over Node http/https.
 * Used instead of requestUrl (cannot stream) and fetch (CORS from
 * app://obsidian.md is rejected by Ollama/LM Studio defaults).
 */
export function chatCompletion(opts: ChatCompletionOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		let url: URL;
		try {
			url = new URL(opts.baseUrl.replace(/\/+$/, "") + "/chat/completions");
		} catch {
			reject(new Error(`Invalid LLM base URL: "${opts.baseUrl}"`));
			return;
		}
		const lib = url.protocol === "https:" ? https : http;

		const payload = JSON.stringify({
			model: opts.model,
			messages: opts.messages,
			temperature: opts.temperature,
			stream: opts.stream,
			...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
		});

		const req = lib.request(
			url,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(payload),
					...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
				},
			},
			(res) => {
				res.setEncoding("utf8");
				let raw = "";

				if (!opts.stream) {
					res.on("data", (chunk: string) => (raw += chunk));
					res.on("end", () => {
						if (res.statusCode && res.statusCode >= 400) {
							reject(httpError(res.statusCode, raw));
							return;
						}
						try {
							const json = JSON.parse(raw);
							resolve(json.choices?.[0]?.message?.content ?? "");
						} catch {
							reject(new Error(`LLM returned unparseable response: ${raw.slice(0, 200)}`));
						}
					});
					return;
				}

				// Streaming: parse SSE "data: {...}" lines.
				if (res.statusCode && res.statusCode >= 400) {
					res.on("data", (chunk: string) => (raw += chunk));
					res.on("end", () => reject(httpError(res.statusCode!, raw)));
					return;
				}
				let buffer = "";
				let full = "";
				res.on("data", (chunk: string) => {
					buffer += chunk;
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed.startsWith("data:")) continue;
						const data = trimmed.slice(5).trim();
						if (data === "[DONE]") continue;
						try {
							const json = JSON.parse(data);
							const token = json.choices?.[0]?.delta?.content;
							if (token) {
								full += token;
								opts.onToken?.(token);
							}
						} catch {
							// partial/garbled SSE line; ignore
						}
					}
				});
				res.on("end", () => resolve(full));
			}
		);

		req.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "ECONNREFUSED") {
				reject(
					new Error(
						`Cannot reach LLM server at ${opts.baseUrl}. Is it running?`
					)
				);
			} else if (req.destroyed && opts.signal?.aborted) {
				reject(new DOMException("Aborted", "AbortError"));
			} else {
				reject(new Error(`LLM request failed: ${err.message}`));
			}
		});

		if (opts.signal) {
			if (opts.signal.aborted) {
				req.destroy();
				reject(new DOMException("Aborted", "AbortError"));
				return;
			}
			opts.signal.addEventListener("abort", () => req.destroy(), { once: true });
		}

		req.write(payload);
		req.end();
	});
}

function httpError(status: number, body: string): Error {
	let detail = body.slice(0, 300);
	try {
		detail = JSON.parse(body)?.error?.message ?? detail;
	} catch {
		// keep raw body
	}
	if (status === 404) {
		return new Error(
			`LLM endpoint returned 404 — check that the base URL includes /v1 and the model name is correct. (${detail})`
		);
	}
	return new Error(`LLM server error ${status}: ${detail}`);
}
