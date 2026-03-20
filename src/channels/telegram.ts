import { exec } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { promisify } from 'util';
import { Api, Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { transcribe } from '../voice.js';
import { ImageAttachment, NewMessage, RegisteredGroup } from '../types.js';

const execAsync = promisify(exec);

/** Sanitize a chat name into a valid group folder name. */
function toFolderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'chat';
}

export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  resetSession: (groupFolder: string, chatJid: string) => void;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  ownerTelegramId: string;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Return the registered group for this chat, auto-registering if the sender
   * is the owner. Returns undefined if the chat should be ignored.
   */
  private ensureGroup(ctx: any, chatJid: string): RegisteredGroup | undefined {
    const existing = this.opts.registeredGroups()[chatJid];
    if (existing) return existing;

    const sender = ctx.from?.id?.toString() || '';
    if (!this.opts.ownerTelegramId || sender !== this.opts.ownerTelegramId)
      return undefined;

    const isGroup =
      ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    const chatName =
      ctx.chat.type === 'private'
        ? ctx.from?.first_name || 'Private'
        : (ctx.chat as any).title || chatJid;

    // Deduplicate folder name against existing groups
    const usedFolders = new Set(
      Object.values(this.opts.registeredGroups()).map((g) => g.folder),
    );
    let folder = toFolderName(chatName);
    if (usedFolders.has(folder)) {
      let n = 2;
      while (usedFolders.has(`${folder}-${n}`)) n++;
      folder = `${folder}-${n}`;
    }
    const group: RegisteredGroup = {
      name: chatName,
      folder,
      trigger: TRIGGER_PATTERN.source,
      added_at: new Date().toISOString(),
      requiresTrigger: isGroup,
      isMain: false,
    };
    this.opts.registerGroup(chatJid, group);
    logger.info({ chatJid, chatName, folder }, 'Auto-registered chat from owner');
    return group;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.command('new', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        ctx.reply('Not a registered chat.');
        return;
      }
      try {
        this.opts.resetSession(group.folder, chatJid);
        try {
          await execAsync(`pkill -f "nanoclaw-bare-${group.folder}"`);
        } catch {
          /* no process to kill */
        }
        ctx.reply('Fresh session started.');
        logger.info(
          { chatJid, folder: group.folder },
          'Session reset via /new',
        );
      } catch (err) {
        logger.error({ err }, 'Failed to reset session');
        ctx.reply('Failed to reset session.');
      }
    });

    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping', 'new']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      const group = this.ensureGroup(ctx, chatJid);
      if (!group) return;

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.ensureGroup(ctx, chatJid);
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.ensureGroup(ctx, chatJid);
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      try {
        // Get highest resolution photo (last in array)
        const photos = ctx.message.photo;
        const bestPhoto = photos[photos.length - 1];
        const file = await ctx.api.getFile(bestPhoto.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

        // Save to group media directory
        const mediaDir = path.join(
          resolveGroupFolderPath(group.folder),
          'media',
        );
        fs.mkdirSync(mediaDir, { recursive: true });
        const ext = path.extname(file.file_path || '.jpg') || '.jpg';
        const filename = `photo-${Date.now()}-${ctx.message.message_id}${ext}`;
        const filePath = path.join(mediaDir, filename);

        await new Promise<void>((resolve, reject) => {
          const dest = fs.createWriteStream(filePath);
          https
            .get(fileUrl, (response) => {
              response.pipe(dest);
              dest.on('finish', () => {
                dest.close();
                resolve();
              });
            })
            .on('error', reject);
        });

        const mimeType =
          ext === '.png'
            ? 'image/png'
            : ext === '.webp'
              ? 'image/webp'
              : ext === '.gif'
                ? 'image/gif'
                : 'image/jpeg';

        const images: ImageAttachment[] = [{ path: filePath, mimeType }];

        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content: `[Photo]${caption}`,
          timestamp,
          is_from_me: false,
          images,
        });

        logger.info(
          { chatJid, senderName, filePath },
          'Photo downloaded and stored',
        );
      } catch (err) {
        logger.error({ err, chatJid }, 'Failed to download photo');
        storeNonText(ctx, '[Photo]');
      }
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));

    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.ensureGroup(ctx, chatJid);
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      try {
        const file = await ctx.getFile();
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const tmpPath = `/tmp/nanoclaw-voice-${Date.now()}.ogg`;

        await new Promise<void>((resolve, reject) => {
          const dest = fs.createWriteStream(tmpPath);
          https
            .get(fileUrl, (response) => {
              response.pipe(dest);
              dest.on('finish', () => {
                dest.close();
                resolve();
              });
            })
            .on('error', reject);
        });

        const text = await transcribe(tmpPath);
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          /* best effort */
        }

        logger.info(
          { chatJid, senderName, textLength: text.length },
          'Voice message transcribed',
        );

        if (!text) {
          logger.warn({ chatJid }, 'Voice transcription returned empty text');
          storeNonText(ctx, '[Voice message - transcription returned empty]');
          return;
        }

        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content: text,
          timestamp,
          is_from_me: false,
          is_voice: true,
        });
      } catch (err) {
        logger.error({ err, chatJid }, 'Failed to transcribe voice message');
        storeNonText(ctx, '[Voice message - transcription failed]');
      }
    });

    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    await this.bot.api.setMyCommands([
      { command: 'new', description: 'Start a fresh session' },
      { command: 'ping', description: 'Check if Dex is online' },
      { command: 'chatid', description: "Get this chat's ID" },
    ]);

    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendPhoto(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendPhoto(numericId, new InputFile(filePath), {
        caption,
      });
      logger.info({ jid, filePath }, 'Telegram photo sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram photo');
      throw err;
    }
  }

  async sendVoice(jid: string, audioPath: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendVoice(numericId, new InputFile(audioPath));
      logger.info({ jid }, 'Telegram voice message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram voice message');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot) return;

    if (!isTyping) {
      const existing = this.typingIntervals.get(jid);
      if (existing) {
        clearInterval(existing);
        this.typingIntervals.delete(jid);
      }
      return;
    }

    if (this.typingIntervals.has(jid)) return;

    const numericId = jid.replace(/^tg:/, '');
    const sendAction = () => {
      this.bot!.api.sendChatAction(numericId, 'typing').catch((err) => {
        logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
      });
    };

    sendAction();
    this.typingIntervals.set(jid, setInterval(sendAction, 4000));
  }
}

export function createTelegram(
  opts: TelegramChannelOpts,
): TelegramChannel | null {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
}
