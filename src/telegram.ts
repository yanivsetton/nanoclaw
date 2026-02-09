/**
 * Telegram Bot Channel for NanoClaw
 *
 * Connects a Telegram bot alongside WhatsApp. Messages are stored in the same
 * database. Chat IDs use the format "tg:<chat_id>" to distinguish from WhatsApp JIDs.
 */
import { Telegraf, Context, Input } from 'telegraf';
import { message } from 'telegraf/filters';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from './config.js';
import { storeChatMetadata, storeMessageDirect } from './db.js';
import { logger } from './logger.js';

// Track which chats had their most recent user message as a voice note
const voiceChats = new Set<number>();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface TranscriptionConfig {
  provider: string;
  openai?: { apiKey: string; model: string };
  enabled: boolean;
  fallbackMessage: string;
}

function loadTranscriptionConfig(): TranscriptionConfig {
  const configPath = path.join(__dirname, '../.transcription.config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return { provider: 'openai', enabled: false, fallbackMessage: '[Voice Message - transcription unavailable]' };
  }
}

async function transcribeTelegramVoice(fileBuffer: Buffer): Promise<string | null> {
  const config = loadTranscriptionConfig();
  if (!config.enabled || !config.openai?.apiKey || config.openai.apiKey === '') {
    return config.fallbackMessage;
  }

  try {
    const OpenAI = (await import('openai')).default;
    const { toFile } = await import('openai');
    const openai = new OpenAI({ apiKey: config.openai.apiKey });
    const file = await toFile(fileBuffer, 'voice.ogg', { type: 'audio/ogg' });
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: config.openai.model || 'whisper-1',
      response_format: 'text',
    });
    const text = (transcription as unknown as string).trim();
    return text || null;
  } catch (err) {
    logger.error({ err }, 'Telegram voice transcription failed');
    return null;
  }
}
import { RegisteredGroup } from './types.js';

export const TG_PREFIX = 'tg:';

export function tgJid(chatId: number | string): string {
  return `${TG_PREFIX}${chatId}`;
}

export function isTelegramJid(jid: string): boolean {
  return jid.startsWith(TG_PREFIX);
}

export function extractTelegramChatId(jid: string): number {
  return Number(jid.slice(TG_PREFIX.length));
}

export interface TelegramBotDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  onMessage: (chatJid: string) => void;
}

let bot: Telegraf | null = null;

export async function startTelegramBot(
  token: string,
  deps: TelegramBotDeps,
): Promise<Telegraf> {
  bot = new Telegraf(token);

  bot.on(message('text'), (ctx: Context) => {
    const msg = ctx.message;
    if (!msg || !('text' in msg)) return;

    const chatId = msg.chat.id;
    voiceChats.delete(chatId);
    const jid = tgJid(chatId);
    const timestamp = new Date(msg.date * 1000).toISOString();

    // Determine chat name
    let chatName: string;
    if (msg.chat.type === 'private') {
      chatName = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || String(chatId);
    } else {
      chatName = ('title' in msg.chat ? msg.chat.title : null) || String(chatId);
    }

    // Determine sender name
    const senderName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ')
      || msg.from?.username
      || String(msg.from?.id);

    // Always store chat metadata for discovery
    storeChatMetadata(jid, timestamp, chatName);

    const groups = deps.registeredGroups();

    // Only store full message content for registered chats
    if (groups[jid]) {
      // Skip bot's own messages (content starting with assistant prefix)
      if (msg.text.startsWith(`${ASSISTANT_NAME}:`)) return;

      storeMessageDirect(
        String(msg.message_id),
        jid,
        String(msg.from?.id || ''),
        senderName,
        msg.text,
        timestamp,
        false,
      );

      // Notify the main app that this chat has new messages
      deps.onMessage(jid);
    }
  });

  bot.on(message('voice'), async (ctx: Context) => {
    const msg = ctx.message;
    if (!msg || !('voice' in msg)) return;

    const chatId = msg.chat.id;
    voiceChats.add(chatId);
    const jid = tgJid(chatId);
    const timestamp = new Date(msg.date * 1000).toISOString();

    let chatName: string;
    if (msg.chat.type === 'private') {
      chatName = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || String(chatId);
    } else {
      chatName = ('title' in msg.chat ? msg.chat.title : null) || String(chatId);
    }

    const senderName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ')
      || msg.from?.username
      || String(msg.from?.id);

    storeChatMetadata(jid, timestamp, chatName);

    const groups = deps.registeredGroups();
    if (!groups[jid]) return;

    try {
      const fileLink = await ctx.telegram.getFileLink(msg.voice.file_id);
      const response = await fetch(fileLink.toString());
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      logger.info({ chatId, bytes: buffer.length }, 'Downloaded Telegram voice message');

      const transcript = await transcribeTelegramVoice(buffer);
      const content = transcript ? `[Voice: ${transcript}]` : '[Voice Message - transcription unavailable]';

      storeMessageDirect(
        String(msg.message_id),
        jid,
        String(msg.from?.id || ''),
        senderName,
        content,
        timestamp,
        false,
      );

      logger.info({ chatId, length: content.length }, 'Stored transcribed voice message');
      deps.onMessage(jid);
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to process Telegram voice message');
      storeMessageDirect(
        String(msg.message_id),
        jid,
        String(msg.from?.id || ''),
        senderName,
        '[Voice Message - transcription failed]',
        timestamp,
        false,
      );
      deps.onMessage(jid);
    }
  });

  bot.catch((err: unknown) => {
    logger.error({ err }, 'Telegram bot error');
  });

  // Launch with long polling (non-blocking)
  bot.launch();
  logger.info('Telegram bot started');

  return bot;
}

export async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  if (!bot) {
    logger.error('Telegram bot not initialized');
    return;
  }
  try {
    await bot.telegram.sendMessage(chatId, text);
    logger.info({ chatId, length: text.length }, 'Telegram message sent');
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send Telegram message');
  }
}

export function shouldReplyWithVoice(chatId: number): boolean {
  if (voiceChats.has(chatId)) {
    voiceChats.delete(chatId);
    return true;
  }
  return false;
}

export async function sendTelegramVoiceMessage(chatId: number, text: string): Promise<void> {
  if (!bot) {
    logger.error('Telegram bot not initialized');
    return;
  }

  try {
    const config = loadTranscriptionConfig();
    if (!config.openai?.apiKey) {
      logger.warn('No OpenAI API key for TTS, falling back to text');
      await bot.telegram.sendMessage(chatId, text);
      return;
    }

    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: config.openai.apiKey });

    const ttsResponse = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: text,
      response_format: 'opus',
    });

    const arrayBuffer = await ttsResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    await bot.telegram.sendVoice(chatId, Input.fromBuffer(buffer, 'reply.ogg'));
    // Also send text for readability
    await bot.telegram.sendMessage(chatId, text);
    logger.info({ chatId, length: text.length }, 'Telegram voice + text reply sent');
  } catch (err) {
    logger.error({ chatId, err }, 'TTS failed, falling back to text');
    try {
      await bot.telegram.sendMessage(chatId, text);
    } catch (sendErr) {
      logger.error({ chatId, sendErr }, 'Failed to send fallback text message');
    }
  }
}

export function stopTelegramBot(): void {
  if (bot) {
    bot.stop('shutdown');
    bot = null;
  }
}
