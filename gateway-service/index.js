import http from 'http';
// Satisfies Render's requirement to bind to a port
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('ok');
}).listen(process.env.PORT || 3000);

import 'dotenv/config';
import {
  AuditLogEvent,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits
} from 'discord.js';
import { createClient } from '@supabase/supabase-js';


const { DISCORD_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!DISCORD_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing required environment variables');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'public' },
  auth: { persistSession: false }
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ]
});

const guildLogChannelCache = new Map();
const healthPort = Number(process.env.PORT || 3000);

async function reportError(source, error, metadata = {}) {
  console.error(`[${source}]`, error);
  await supabase.from('error_reports').insert({
    service: 'gateway-service',
    source,
    message: error instanceof Error ? error.message : String(error),
    metadata
  });
}

async function logActivity(eventType, userId, userTag, content, metadata = {}) {
  const { error } = await supabase.from('activity_logs').insert({
    event_type: eventType,
    user_id: userId,
    user_tag: userTag,
    content,
    metadata
  });

  if (error) {
    await reportError('logActivity', error, { eventType, userId });
    return;
  }

  if (metadata.guild_id) {
    await sendActivityEmbed(metadata.guild_id, eventType, userId, userTag, content, metadata);
  }
}

async function getGuildLogChannelId(guildId) {
  if (guildLogChannelCache.has(guildId)) {
    return guildLogChannelCache.get(guildId);
  }

  const { data, error } = await supabase
    .from('guild_configs')
    .select('log_channel_id')
    .eq('guild_id', guildId)
    .maybeSingle();

  if (error) {
    await reportError('getGuildLogChannelId', error, { guildId });
    return null;
  }

  const channelId = data?.log_channel_id || null;
  guildLogChannelCache.set(guildId, channelId);
  return channelId;
}

function buildActivityEmbed(eventType, userId, userTag, content, metadata) {
  const isJoin = eventType === 'voice_join';
  const isLeave = eventType === 'voice_leave';
  const isDelete = eventType === 'message_delete';

  const color = isJoin ? 0x2ecc71 : (isLeave || isDelete ? 0xe74c3c : 0x5865f2);
  const title = isJoin
    ? 'Voice Join'
    : isLeave
      ? 'Voice Leave'
      : isDelete
        ? 'Message Deleted'
        : eventType;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(content)
    .setTimestamp(new Date())
    .addFields(
      { name: 'User', value: `${userTag} (${userId})`, inline: false },
      { name: 'User ID', value: userId, inline: true }
    );

  if (metadata.message_id) {
    embed.addFields({ name: 'Message ID', value: String(metadata.message_id), inline: true });
  }

  if (metadata.channel_id) {
    embed.addFields({ name: 'Channel ID', value: String(metadata.channel_id), inline: true });
  }

  return embed;
}

async function sendActivityEmbed(guildId, eventType, userId, userTag, content, metadata) {
  const logChannelId = await getGuildLogChannelId(guildId);
  if (!logChannelId) {
    return;
  }

  const channel = await client.channels.fetch(logChannelId).catch(() => null);
  if (!channel?.isTextBased()) {
    return;
  }

  const embed = buildActivityEmbed(eventType, userId, userTag, content, metadata);
  await channel.send({ embeds: [embed] }).catch((error) => reportError('sendActivityEmbed', error, { guildId, logChannelId }));
}

async function fetchMessageDeleteExecutor(message) {
  if (!message.guild?.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    return null;
  }

  try {
    const logs = await message.guild.fetchAuditLogs({
      type: AuditLogEvent.MessageDelete,
      limit: 6
    });

    const entry = logs.entries.find((logEntry) => {
      const isSameTarget = logEntry.target?.id === message.author?.id;
      const isRecent = Math.abs(Date.now() - logEntry.createdTimestamp) < 15000;
      return isSameTarget && isRecent;
    });

    if (!entry) {
      return null;
    }

    return {
      executorId: entry.executor?.id || null,
      executorTag: entry.executor?.tag || null
    };
  } catch (error) {
    await reportError('fetchMessageDeleteExecutor', error, {
      guildId: message.guild?.id,
      messageId: message.id
    });
    return null;
  }
}

async function createVoiceSession(member, channel) {
  const { data, error } = await supabase
    .from('voice_sessions')
    .insert({
      user_id: member.user.id,
      user_tag: member.user.tag,
      channel_id: channel.id,
      channel_name: channel.name,
      started_at: new Date().toISOString()
    })
    .select('id')
    .single();

  if (error) {
    await reportError('createVoiceSession', error, { userId: member.user.id, channelId: channel.id });
    return;
  }

  await logActivity('voice_join', member.user.id, member.user.tag, `Joined ${channel.name}`, {
    session_id: data.id,
    channel_id: channel.id
  });
}

async function closeVoiceSession(member, oldState) {
  const { data: session, error: fetchError } = await supabase
    .from('voice_sessions')
    .select('id,started_at,channel_id,channel_name')
    .eq('user_id', member.user.id)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fetchError) {
    await reportError('closeVoiceSession.fetch', fetchError, { userId: member.user.id });
    return;
  }

  if (!session) {
    await logActivity('voice_leave', member.user.id, member.user.tag, `Left ${oldState.channel?.name || 'voice channel'}`, {
      unmatched_session: true
    });
    return;
  }

  const endedAt = new Date();
  const durationSeconds = Math.max(0, Math.floor((endedAt.getTime() - new Date(session.started_at).getTime()) / 1000));

  const { error: updateError } = await supabase
    .from('voice_sessions')
    .update({
      ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds
    })
    .eq('id', session.id);

  if (updateError) {
    await reportError('closeVoiceSession.update', updateError, { sessionId: session.id, userId: member.user.id });
    return;
  }

  await logActivity('voice_leave', member.user.id, member.user.tag, `Left ${session.channel_name}`, {
    session_id: session.id,
    duration_seconds: durationSeconds,
    channel_id: session.channel_id
  });
}

async function updateHeartbeat() {
  const activeVoiceConnections = client.guilds.cache.reduce(
    (count, guild) => count + guild.voiceStates.cache.filter((state) => !state.member?.user?.bot && state.channelId).size,
    0
  );

  const payload = {
    service_name: 'gateway-service',
    status: 'alive',
    last_seen_at: new Date().toISOString(),
    metadata: {
      pid: process.pid,
      rss: process.memoryUsage().rss,
      ws_ping: client.ws.ping,
      active_voice_connections: activeVoiceConnections
    }
  };

  const { error } = await supabase
    .from('system_status')
    .upsert(payload, { onConflict: 'service_name' });

  if (error) {
    await reportError('updateHeartbeat', error);
  }

  await fetch(`http://localhost:${healthPort}`).catch((heartbeatError) => {
    reportError('updateHeartbeat.selfCheck', heartbeatError);
  });
}

function handleVoiceRecording(channelId, users) {
  // @discordjs/voice: joinVoiceChannel with guild + adapter creator.
  // Subscribe to user audio receivers and pipe Opus streams.
  // Transcode or package audio chunks and write temporary files.
  // Upload final artifacts to Supabase Storage bucket: voice_records.
  return { channelId, usersCount: users.length };
}

client.on(Events.ClientReady, async (readyClient) => {
  console.log(`Gateway online as ${readyClient.user.tag}`);
  await updateHeartbeat();
  setInterval(() => {
    updateHeartbeat().catch((error) => reportError('heartbeat.interval', error));
  }, 10 * 60 * 1000);
});

client.on(Events.MessageDelete, async (message) => {
  try {
    if (!message.inGuild() || !message.author || message.author.bot) {
      return;
    }

    const deletedContent = message.content?.trim() || '[empty or uncached message]';
    const moderatorInfo = await fetchMessageDeleteExecutor(message);

    await logActivity('message_delete', message.author.id, message.author.tag, deletedContent, {
      guild_id: message.guild.id,
      channel_id: message.channelId,
      message_id: message.id,
      target_user_id: message.author.id,
      target_user_tag: message.author.tag,
      executor_user_id: moderatorInfo?.executorId || null,
      executor_user_tag: moderatorInfo?.executorTag || null
    });
  } catch (error) {
    await reportError('messageDelete.handler', error);
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const member = newState.member || oldState.member;
    if (!member?.user || member.user.bot) {
      return;
    }

    const joinedChannel = !oldState.channelId && newState.channelId;
    const leftChannel = oldState.channelId && !newState.channelId;

    if (joinedChannel && newState.channel) {
      handleVoiceRecording(newState.channel.id, [member.user.id]);
      await createVoiceSession(member, newState.channel);
    }

    if (leftChannel) {
      await closeVoiceSession(member, oldState);
    }
  } catch (error) {
    await reportError('voiceStateUpdate.handler', error);
  }
});

process.on('unhandledRejection', (reason) => {
  reportError('process.unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
});

process.on('uncaughtException', (error) => {
  reportError('process.uncaughtException', error).finally(() => process.exit(1));
});

client.login(DISCORD_BOT_TOKEN).catch((error) => reportError('client.login', error));
