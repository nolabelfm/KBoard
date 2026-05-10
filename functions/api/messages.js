const DISCORD_API_BASE = 'https://discord.com/api/v10';

function json(status, data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      ...extraHeaders,
    },
  });
}

function getBearerToken(request) {
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error('Invalid JSON');
  }
}

async function supabaseAuthUser(env, accessToken) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    throw new Error('Unauthorized');
  }

  return res.json();
}

async function supabaseAllowedUser(env, accessToken, userId) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/allowed_users`);
  url.searchParams.set('select', 'supabase_user_id,discord_id,email,can_access,is_admin,is_bot');
  url.searchParams.set('supabase_user_id', `eq.${userId}`);
  url.searchParams.set('limit', '1');

  const res = await fetch(url.toString(), {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error('Access check failed');
  }

  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function discordRequest(env, path, init = {}) {
  const res = await fetch(`${DISCORD_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      ...(init.headers || {}),
    },
  });

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const message = data && typeof data === 'object' && data.message ? data.message : (typeof data === 'string' ? data : `Discord API error (${res.status})`);
    const code = data && typeof data === 'object' && data.code ? ` (code ${data.code})` : '';
    throw new Error(`Discord ${res.status}${code}: ${message}`);
  }

  return data;
}

// FIX: flatten author into top-level string + bool + avatar URL
function formatMessage(m) {
  const authorId = m.author?.id || null;
  const avatarHash = m.author?.avatar || null;
  const avatarUrl = authorId && avatarHash
    ? `https://cdn.discordapp.com/avatars/${authorId}/${avatarHash}.png?size=64`
    : null;

  return {
    id: m.id,
    message_id: m.id,
    content: m.content ?? '',
    created_at: m.timestamp || m.created_at || null,
    // FIX: plain string, not an object
    author: m.author?.global_name || m.author?.username || 'unknown',
    // FIX: top-level bool
    bot: Boolean(m.author?.bot),
    // FIX: resolved CDN URL (null if no avatar)
    avatar: avatarUrl,
  };
}

async function handleRequest(request, env) {
  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' } });
    }

    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.DISCORD_BOT_TOKEN) {
      return json(500, {
        error: 'Missing environment variables',
        details: {
          SUPABASE_URL: Boolean(env.SUPABASE_URL),
          SUPABASE_ANON_KEY: Boolean(env.SUPABASE_ANON_KEY),
          DISCORD_BOT_TOKEN: Boolean(env.DISCORD_BOT_TOKEN),
        },
      });
    }

    const accessToken = getBearerToken(request);
    if (!accessToken) {
      return json(401, { error: 'Missing Bearer token' });
    }

    let user;
    let accessRow;
    try {
      user = await supabaseAuthUser(env, accessToken);
      accessRow = await supabaseAllowedUser(env, accessToken, user.id);
    } catch (err) {
      return json(401, { error: err.message || 'Unauthorized' });
    }

    if (!accessRow || !accessRow.can_access) {
      return json(403, { error: 'Access denied' });
    }

    const url = new URL(request.url);

    if (request.method === 'GET') {
      const channelId = url.searchParams.get('channelId');
      const messageId = url.searchParams.get('messageId');
      if (!channelId) return json(400, { error: 'channelId required' });

      try {
        if (messageId) {
          const msg = await discordRequest(env, `/channels/${channelId}/messages/${messageId}`);
          return json(200, formatMessage(msg));
        }
        const msgs = await discordRequest(env, `/channels/${channelId}/messages?limit=10`);
        return json(200, Array.isArray(msgs) ? msgs.map(formatMessage) : []);
      } catch (err) {
        return json(500, { error: err.message, where: 'GET /api/messages' });
      }
    }

    if (!accessRow.is_admin && !accessRow.is_bot) {
      return json(403, { error: 'Admin or bot access required' });
    }

    if (request.method === 'POST') {
      const { channelId, content, reactionEmoji } = await readJson(request);
      if (!channelId || !content) return json(400, { error: 'channelId and content required' });
      const msg = await discordRequest(env, `/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (reactionEmoji) {
        await discordRequest(env, `/channels/${channelId}/messages/${msg.id}/reactions/${encodeURIComponent(reactionEmoji)}/@me`, {
          method: 'PUT',
        });
      }
      return json(200, formatMessage(msg));
    }

    if (request.method === 'PATCH') {
      const { channelId, messageId, content } = await readJson(request);
      if (!channelId || !messageId || !content) return json(400, { error: 'channelId, messageId and content required' });
      const msg = await discordRequest(env, `/channels/${channelId}/messages/${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      return json(200, formatMessage(msg));
    }

    if (request.method === 'DELETE') {
      const { channelId, messageId } = await readJson(request);
      if (!channelId || !messageId) return json(400, { error: 'channelId and messageId required' });
      await discordRequest(env, `/channels/${channelId}/messages/${messageId}`, {
        method: 'DELETE',
      });
      return json(200, { ok: true });
    }
    return json(405, { error: 'Method Not Allowed' });
  } catch (err) {
    return json(500, { error: err.message, stack: String(err?.stack || '') });
  }
}

export async function onRequest(context) {
  return handleRequest(context.request, context.env);
}
