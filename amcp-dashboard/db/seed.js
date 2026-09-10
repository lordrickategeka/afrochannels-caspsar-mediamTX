require('dotenv').config();
const bcrypt = require('bcrypt');

async function seed() {
  // SQLite creates its file automatically on first connection - nothing to
  // provision up front the way MySQL needed a CREATE DATABASE step.
  const { sequelize, User, Channel, Source, BrandingPreset } = require('./models');
  await sequelize.sync();

  const userCount = await User.count();
  if (userCount === 0) {
    const username = process.env.SEED_ADMIN_USER || 'admin';
    const password = process.env.SEED_ADMIN_PASS || 'admin';
    const passwordHash = await bcrypt.hash(password, 10);
    await User.create({ username, passwordHash });
    console.log(`[Seed] Created admin user "${username}" with password "${password}" - log in and this is the only copy of that password, it is not recoverable.`);
  } else {
    console.log('[Seed] Users already exist, skipping.');
  }

  const channelCount = await Channel.count();
  if (channelCount === 0) {
    const channel = await Channel.create({
      name: 'Cinemachi Action',
      casparChannelNumber: 1,
      rtmpTarget: 'rtmp://127.0.0.1:1935/live/cinemachi_branded',
      isActive: true
    });

    await Source.bulkCreate([
      { channelId: channel.id, label: 'Primary', url: 'srt://mma-1.mimyuni.net:10697?mode=caller&transtype=live&latency=2000000', priority: 0 },
      { channelId: channel.id, label: 'Backup 1', url: 'srt://mma-2.mimyuni.net:10697?mode=caller&transtype=live&latency=2000000', priority: 1 },
      { channelId: channel.id, label: 'Backup 2', url: 'srt://mma-3.mimyuni.net:10697?mode=caller&transtype=live&latency=2000000', priority: 2 }
    ]);

    await BrandingPreset.bulkCreate([
      { channelId: channel.id, name: 'Default', template: 'lower_third', data: { title: 'CINEMACHI ACTION', subtitle: 'AFRO MOBILE MEDIA | CH 06' } },
      { channelId: channel.id, name: 'Default', template: 'logo_bug', data: { text: 'CH 06' } },
      { channelId: channel.id, name: 'Default', template: 'ticker', data: { text: 'BREAKING NEWS...' } }
    ]);

    console.log(`[Seed] Created channel "${channel.name}" with 3 sources and 3 default branding presets.`);
  } else {
    console.log('[Seed] Channels already exist, skipping.');
  }

  await sequelize.close();
}

seed().catch((err) => {
  console.error('[Seed] Failed:', err);
  process.exit(1);
});
