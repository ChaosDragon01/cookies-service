import 'dotenv/config';
import {
  AuditLogEvent,
  Client,
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
  }
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
  const payload = {
    service_name: 'gateway-service',
    status: 'alive',
    last_seen_at: new Date().toISOString(),
    metadata: { pid: process.pid }
  };

  const { error } = await supabase
    .from('system_status')
    .upsert(payload, { onConflict: 'service_name' });

  if (error) {
    await reportError('updateHeartbeat', error);
  }
}

client.on(Events.ClientReady, async (readyClient) => {
  console.log(`Gateway online as ${readyClient.user.tag}`);
  await updateHeartbeat();
  setInterval(() => {
    updateHeartbeat().catch((error) => reportError('heartbeat.interval', error));
  }, 5 * 60 * 1000);
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
