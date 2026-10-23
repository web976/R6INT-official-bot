require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { Client, GatewayIntentBits, ChannelType, Events, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
 
const E = process.env;
for (const k of ['DISCORD_TOKEN', 'GUILD_ID', 'DASHBOARD_PASSWORD']) {
  if (!E[k]) { console.error('MISSING in .env: ' + k); process.exit(1); }
}
const BASE = E.BASE_URL || `http://localhost:${E.PORT || 3000}`;
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const app = express();
 
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: E.SESSION_SECRET || crypto.randomBytes(16).toString('hex'),
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: BASE.startsWith('https'), maxAge: 7 * 864e5 }
}));
app.use(express.static(path.join(__dirname, 'public')));
 
// ---------- Password login ----------
const ATTEMPTS = {};
app.post('/auth/login', (req, res) => {
  const now = Date.now();
  const tries = ATTEMPTS[req.ip] = (ATTEMPTS[req.ip] || []).filter(t => now - t < 15 * 60 * 1000);
  if (tries.length >= 5) return res.status(429).json({ error: 'Too many wrong tries. Wait 15 minutes.' });
 
  const given = Buffer.from(String((req.body || {}).password || ''));
  const real = Buffer.from(E.DASHBOARD_PASSWORD);
  const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
 
  if (!ok) { tries.push(now); return res.status(401).json({ error: 'Wrong password' }); }
  req.session.user = { name: 'Admin' };
  res.json({ ok: true });
});
app.get('/auth/logout', (req, res) => req.session.destroy(() => res.redirect('/')));
const auth = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Not logged in' });
 
// ---------- Dashboard API ----------
app.get('/api/me', auth, (req, res) => res.json(req.session.user));
 
app.get('/api/data', auth, async (req, res) => {
  try {
    const g = await client.guilds.fetch(E.GUILD_ID);
    const channels = await g.channels.fetch();
    const roles = await g.roles.fetch();
    const me = await g.members.fetchMe();
    res.json({
      server: g.name,
      canMentionAll: me.permissions.has(PermissionFlagsBits.MentionEveryone),
      channels: [...channels.values()]
        .filter(c => c && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(c.type))
        .sort((a, b) => a.rawPosition - b.rawPosition).map(c => ({ id: c.id, name: c.name })),
      // every role except @everyone, so you can ping any role
      roles: [...roles.values()].filter(r => r.id !== g.id)
        .sort((a, b) => b.position - a.position)
        .map(r => ({ id: r.id, name: r.name, color: r.hexColor, mentionable: r.mentionable }))
    });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});
 
const web = u => (typeof u === 'string' && /^https?:\/\//.test(u)) ? u : undefined;
 
app.post('/api/send', auth, async (req, res) => {
  try {
    const { channelId, content = '', roleIds = [], everyone = false, embed, buttons = [] } = req.body;
    const ids = roleIds.filter(i => /^\d+$/.test(i));
    const text = [everyone ? '@everyone' : '', ...ids.map(i => `<@&${i}>`), content].filter(Boolean).join(' ');
    const msg = { content: text || undefined, allowedMentions: { parse: everyone ? ['everyone'] : [], roles: ids } };
 
    if (embed) {
      msg.embeds = [{
        title: embed.title || undefined, description: embed.description || undefined,
        url: web(embed.url), color: parseInt((embed.color || '#5865f2').slice(1), 16) || 0,
        author: embed.author ? { name: embed.author } : undefined,
        footer: embed.footer ? { text: embed.footer } : undefined,
        thumbnail: web(embed.thumbnail) && { url: embed.thumbnail },
        image: web(embed.image) && { url: embed.image },
        timestamp: embed.timestamp ? new Date().toISOString() : undefined,
        fields: (embed.fields || []).filter(f => f.name && f.value).slice(0, 25)
          .map(f => ({ name: f.name, value: f.value, inline: !!f.inline }))
      }];
    }
    const b = buttons.filter(x => x.label && web(x.url)).slice(0, 5);
    if (b.length) msg.components = [new ActionRowBuilder().addComponents(
      b.map(x => new ButtonBuilder().setLabel(x.label).setURL(x.url).setStyle(ButtonStyle.Link)))];
 
    if (!msg.content && !msg.embeds) return res.status(400).json({ error: 'Write a message or turn on the embed first.' });
    const ch = await client.channels.fetch(channelId);
    if (!ch || ch.guildId !== E.GUILD_ID) return res.status(403).json({ error: 'That channel is not in your server.' });
    await ch.send(msg);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});
 
client.once(Events.ClientReady, () => {
  console.log('Bot online: ' + client.user.tag);
  app.listen(E.PORT || 3000, () => console.log('Dashboard: ' + BASE));
});
client.login(E.DISCORD_TOKEN).catch(e => { console.error('Bot login failed: ' + e.message); process.exit(1); });
 