/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
	async fetch(request, env, ctx) {
		try {
			const url = new URL(request.url);

			// 健康检查
			if (request.method === 'GET') {
				return jsonResponse({
					ok: true,
					service: 'dify-telegram-worker',
					path: url.pathname,
					hasTelegramToken: Boolean(env.TELEGRAM_BOT_TOKEN),
					hasDifyApiKey: Boolean(env.DIFY_API_KEY),
					hasDifyApiUrl: Boolean(env.DIFY_API_URL),
					hasKV: Boolean(env.DIFY_CONVERSATIONS),
					hasQueue: Boolean(env.TELEGRAM_QUEUE),
				});
			}

			// Telegram Webhook 只接受 POST
			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
			}

			const update = await request.json();

			const message = update.message || update.edited_message;

			if (!message || !message.text) {
				return jsonResponse({ ok: true, skipped: true });
			}

			const chatId = message.chat?.id;
			const userId = String(message.from?.id || chatId || 'unknown');
			const text = message.text;
			const updateId = update.update_id;

			if (!chatId || !text) {
				return jsonResponse({ ok: true, skipped: true });
			}

			// 可选：限制用户
			if (env.ALLOWED_USER_IDS && env.ALLOWED_USER_IDS.trim()) {
				const allowed = env.ALLOWED_USER_IDS.split(',')
					.map((x) => x.trim())
					.filter(Boolean);

				if (!allowed.includes(userId)) {
					await sendTelegramMessage(env, chatId, '你没有权限使用此机器人。');
					return jsonResponse({ ok: true });
				}
			}

			// /start 这种轻任务可以直接处理，不进队列
			if (text.startsWith('/start')) {
				await sendTelegramMessage(
					env,
					chatId,
					`你好，我是 Dify 驱动的新闻助手。

 你可以直接问我：

 - 今天 AI 行业有什么新闻？
 - 总结过去 24 小时 OpenAI 的新闻
 - 本周加密货币有什么大事？
 - 展开第 1 条新闻

 命令：
 /reset 重置当前对话`,
				);

				return jsonResponse({ ok: true });
			}

			// /reset 也可以直接处理
			if (text.startsWith('/reset')) {
				await deleteConversationId(env, userId);
				await sendTelegramMessage(env, chatId, '已重置当前对话。');
				return jsonResponse({ ok: true });
			}

			// 防止 Telegram 重试导致同一 update 重复入队
			if (updateId !== undefined && env.DIFY_CONVERSATIONS) {
				const updateKey = `telegram:update:${updateId}`;
				const exists = await env.DIFY_CONVERSATIONS.get(updateKey);

				if (exists) {
					return jsonResponse({
						ok: true,
						duplicated: true,
						updateId,
					});
				}

				await env.DIFY_CONVERSATIONS.put(updateKey, '1', {
					expirationTtl: 60 * 60,
				});
			}

			// 如果没有绑定 Queue，返回明确错误
			if (!env.TELEGRAM_QUEUE) {
				await sendTelegramMessage(env, chatId, '服务未配置队列 TELEGRAM_QUEUE，无法处理长任务。');

				return jsonResponse(
					{
						ok: false,
						error: 'TELEGRAM_QUEUE binding is missing',
					},
					500,
				);
			}

			// 把耗时任务放入 Cloudflare Queue
			await env.TELEGRAM_QUEUE.send({
				updateId,
				chatId,
				userId,
				text,
				createdAt: Date.now(),
			});

			// 立即回复一个提示
			await sendTelegramMessage(env, chatId, '已收到，正在检索和总结，请稍等...');

			// 立即返回 Telegram，避免 Webhook 超时
			return jsonResponse({
				ok: true,
				queued: true,
			});
		} catch (error) {
			return jsonResponse(
				{
					ok: false,
					error: String(error),
				},
				500,
			);
		}
	},

	async queue(batch, env, ctx) {
		for (const message of batch.messages) {
			const task = message.body;

			try {
				await handleQueuedTelegramTask(task, env);

				// 成功后确认消息
				message.ack();
			} catch (error) {
				console.error('Queue task failed:', error);

				// 尝试通知 Telegram 用户
				try {
					if (task?.chatId) {
						await sendTelegramMessage(env, task.chatId, `处理失败：${String(error)}`);
					}
				} catch (notifyError) {
					console.error('Failed to notify Telegram:', notifyError);
				}

				// 如果你想让失败任务自动重试，可以改成 message.retry()
				// 这里为了避免反复失败刷屏，默认 ack 掉
				message.ack();
			}
		}
	},
};

async function handleQueuedTelegramTask(task, env) {
	const { chatId, userId, text } = task;

	if (!chatId || !userId || !text) {
		throw new Error('Invalid queue task payload');
	}

	const difyResult = await callDify(env, {
		query: text,
		userId,
	});

	const answer = difyResult.answer || 'Dify 没有返回内容。';

	await sendTelegramMessage(env, chatId, answer);
}

async function callDify(env, { query, userId }) {
	const conversationId = await getConversationId(env, userId);

	const payload = {
		inputs: {},
		query,
		response_mode: 'blocking',
		conversation_id: conversationId || '',
		user: userId,
	};

	const resp = await fetch(env.DIFY_API_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.DIFY_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(payload),
	});

	const text = await resp.text();

	if (!resp.ok) {
		throw new Error(`Dify API error ${resp.status}: ${text}`);
	}

	let data;

	try {
		data = JSON.parse(text);
	} catch (e) {
		throw new Error(`Dify 返回非 JSON：${text}`);
	}

	if (data.conversation_id) {
		await saveConversationId(env, userId, data.conversation_id);
	}

	return data;
}

async function sendTelegramMessage(env, chatId, text) {
	const token = env.TELEGRAM_BOT_TOKEN;

	if (!token) {
		throw new Error('Missing TELEGRAM_BOT_TOKEN');
	}

	const url = `https://api.telegram.org/bot${token}/sendMessage`;

	const chunks = splitText(text || '', 3500);

	for (const chunk of chunks) {
		const resp = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				chat_id: chatId,
				text: chunk,
				disable_web_page_preview: true,
			}),
		});

		if (!resp.ok) {
			const err = await resp.text();
			throw new Error(`Telegram sendMessage error ${resp.status}: ${err}`);
		}
	}
}

function splitText(text, maxLength) {
	if (!text) return [''];

	const chunks = [];

	for (let i = 0; i < text.length; i += maxLength) {
		chunks.push(text.slice(i, i + maxLength));
	}

	return chunks;
}

async function getConversationId(env, userId) {
	// 如果没有绑定 KV，则不保存多轮会话
	if (!env.DIFY_CONVERSATIONS) {
		return '';
	}

	const key = `dify:conversation:${userId}`;
	return await env.DIFY_CONVERSATIONS.get(key);
}

async function saveConversationId(env, userId, conversationId) {
	if (!env.DIFY_CONVERSATIONS) {
		return;
	}

	const key = `dify:conversation:${userId}`;

	// 7 天过期
	await env.DIFY_CONVERSATIONS.put(key, conversationId, {
		expirationTtl: 60 * 60 * 24 * 7,
	});
}

async function deleteConversationId(env, userId) {
	if (!env.DIFY_CONVERSATIONS) {
		return;
	}

	const key = `dify:conversation:${userId}`;
	await env.DIFY_CONVERSATIONS.delete(key);
}

function jsonResponse(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
		},
	});
}
