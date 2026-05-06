import {
  InteractionResponseType,
  InteractionType,
  verifyKey
} from 'discord-interactions';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function reportError(env, source, error, metadata = {}) {
  console.error(`[${source}]`, error);
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return;
  }

  await fetch(`${env.SUPABASE_URL}/rest/v1/error_reports`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=minimal'
    },
    body: JSON.stringify([
      {
        service: 'worker-commands',
        source,
        message: error instanceof Error ? error.message : String(error),
        metadata
      }
    ])
  });
}

async function supabaseSelect(env, query, key = env.SUPABASE_ANON_KEY) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${query}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase select failed: ${response.status}`);
  }

  return response.json();
}

async function clearLogs(env) {
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/activity_logs?id=gt.0`,
    {
      method: 'DELETE',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=minimal'
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Log clear failed: ${response.status}`);
  }
}

async function handleLogsView(env) {
  const logs = await supabaseSelect(
    env,
    'activity_logs?select=event_type,user_tag,content,created_at&order=created_at.desc&limit=5'
  );

  if (!logs.length) {
    return jsonResponse({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'No activity logs yet.' }
    });
  }

  const lines = logs.map((log, index) => {
    const timestampLabel = new Date(log.created_at).toISOString();
    return `${index + 1}. [${timestampLabel}] ${log.event_type} - ${log.user_tag} - ${log.content}`;
  });

  return jsonResponse({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: lines.join('\n'),
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 1, label: 'Refresh', custom_id: 'logs:view' },
            { type: 2, style: 4, label: 'Clear', custom_id: 'logs:clear' }
          ]
        },
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: 'logs:filter',
              placeholder: 'Filter display',
              options: [
                { label: 'All events', value: 'all' },
                { label: 'Message deletes', value: 'message_delete' },
                { label: 'Voice joins', value: 'voice_join' },
                { label: 'Voice leaves', value: 'voice_leave' }
              ]
            }
          ]
        }
      ]
    }
  });
}

async function handleLogsClear(env) {
  await clearLogs(env);
  return jsonResponse({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: 'Activity logs cleared.' }
  });
}

async function handleLookupAutocomplete(interaction, env) {
  const focused = interaction.data?.options?.find((opt) => opt.focused);
  const search = encodeURIComponent(focused?.value || '');
  const query = `activity_logs?select=user_tag&user_tag=ilike.*${search}*&order=created_at.desc&limit=25`;
  const rows = await supabaseSelect(env, query);

  const deduped = [...new Set(rows.map((row) => row.user_tag).filter(Boolean))].slice(0, 25);

  return jsonResponse({
    type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
    data: {
      choices: deduped.map((tag) => ({ name: tag, value: tag }))
    }
  });
}

async function handleComponent(interaction, env) {
  if (interaction.data.custom_id === 'logs:view') {
    return handleLogsView(env);
  }

  if (interaction.data.custom_id === 'logs:clear') {
    return handleLogsClear(env);
  }

  if (interaction.data.custom_id === 'logs:filter') {
    const selected = interaction.data.values?.[0] || 'all';
    const filter = selected === 'all' ? '' : `&event_type=eq.${selected}`;
    const logs = await supabaseSelect(
      env,
      `activity_logs?select=event_type,user_tag,content,created_at&order=created_at.desc&limit=5${filter}`
    );

    const lines = logs.length
      ? logs.map((log, index) => `${index + 1}. ${log.event_type} - ${log.user_tag} - ${log.content}`)
      : ['No logs for selected filter.'];

    return jsonResponse({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: { content: lines.join('\n') }
    });
  }

  return jsonResponse({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: 'Unknown component interaction.' }
  });
}

async function handleCommand(interaction, env) {
  const commandName = interaction.data?.name;

  if (commandName === 'ping') {
    return jsonResponse({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'Pong!' }
    });
  }

  if (commandName === 'status') {
    const statusRows = await supabaseSelect(
      env,
      'system_status?select=service_name,status,last_seen_at&order=last_seen_at.desc&limit=5'
    );
    const message = statusRows.length
      ? statusRows
          .map((row) => `${row.service_name}: ${row.status} at ${new Date(row.last_seen_at).toISOString()}`)
          .join('\n')
      : 'No system status rows found.';

    return jsonResponse({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: message }
    });
  }

  if (commandName === 'logs') {
    const sub = interaction.data?.options?.[0]?.name;
    if (sub === 'clear') {
      return handleLogsClear(env);
    }
    return handleLogsView(env);
  }

  return jsonResponse({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: 'Unknown command.' }
  });
}

export default {
  async fetch(request, env) {
    try {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }

      const signature = request.headers.get('x-signature-ed25519');
      const timestamp = request.headers.get('x-signature-timestamp');
      const bodyText = await request.text();

      if (!signature || !timestamp) {
        return new Response('Missing signature headers', { status: 401 });
      }

      const isValid = await verifyKey(bodyText, signature, timestamp, env.DISCORD_PUBLIC_KEY);
      if (!isValid) {
        return new Response('Bad request signature', { status: 401 });
      }

      const interaction = JSON.parse(bodyText);

      if (interaction.type === InteractionType.PING) {
        return jsonResponse({ type: InteractionResponseType.PONG });
      }

      if (interaction.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
        if (interaction.data?.name === 'lookup') {
          return handleLookupAutocomplete(interaction, env);
        }
      }

      if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
        return handleComponent(interaction, env);
      }

      if (interaction.type === InteractionType.APPLICATION_COMMAND) {
        return handleCommand(interaction, env);
      }

      return jsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: 'Unsupported interaction type.' }
      });
    } catch (error) {
      await reportError(env, 'worker.fetch', error);
      return jsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: 'Internal error while handling interaction.' }
      });
    }
  }
};
