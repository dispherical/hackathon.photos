require('dotenv').config()
const { execSync } = require('node:child_process');
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const B2 = require('backblaze-b2');

const b2 = new B2({
  applicationKeyId: process.env.BACKBLAZE_APPKEY_ID,
  applicationKey: process.env.BACKBLAZE_APPKEY,
});

const FORBIDDEN_PATTERNS = [
  /[;&|`$(){}]/,
  /\.\./,
  /\n.*\[.*\]/,
];

function validateRcloneConfig(config) {
  if (!config || typeof config !== 'string') return false;
  if (config.length > 4096) return false;

  const lines = config.split('\n');
  let hasGuestSection = false;
  let sectionCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (FORBIDDEN_PATTERNS.some(p => p.test(trimmed))) return false;

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const sectionName = trimmed.slice(1, -1).trim();
      if (sectionName === 'guest') hasGuestSection = true;
      if (sectionName === 'host') return false;
      sectionCount++;
      if (sectionCount > 3) return false;
    }
  }

  return hasGuestSection;
}

async function syncEvent(event) {
  if (!event.rcloneConfig) return;

  if (!validateRcloneConfig(event.rcloneConfig)) {
    console.error(`Invalid rclone config for event ${event.id}, skipping.`);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rclone-'));
  const tmpFile = path.join(tmpDir, 'config.conf');

  try {
    let config = event.rcloneConfig.trim();
    config += `\n[host]\ntype = b2\naccount = ${process.env.BACKBLAZE_APPKEY_ID}\nhard_delete = true\nkey = ${process.env.BACKBLAZE_APPKEY}\n`;

    fs.writeFileSync(tmpFile, config, { mode: 0o600 });

    const dest = `host:hackathon-photos/${event.id}`;
    const cmd = `rclone copy guest: ${dest} --config ${tmpFile} --max-transfer 5G --transfers 4`;

    console.log(`Syncing event ${event.id}...`);
    execSync(cmd, { timeout: 300000, stdio: 'pipe' });
    console.log(`Finished syncing event ${event.id}`);

    await b2.authorize();
    const result = await b2.listFileNames({
      bucketId: process.env.BACKBLAZE_BUCKET_ID,
      prefix: `${event.id}/`
    });

    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    for (const file of result.data.files) {
      if (!allowedExtensions.some(ext => file.fileName.toLowerCase().endsWith(ext))) continue;

      const existing = await prisma.photo.findFirst({
        where: { eventId: event.id, fileName: file.fileName.split('/').pop() }
      });
      if (existing) continue;

      await prisma.photo.create({
        data: {
          fileName: file.fileName.split('/').pop(),
          url: `https://cdn.hackathon.photos/${file.fileName}`,
          eventId: event.id,
          size: file.contentLength || 0,
          mimeType: file.contentType || "",
        }
      });
    }
  } catch (e) {
    console.error(`Rclone sync failed for event ${event.id}: ${e.message}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { }
    try { fs.rmdirSync(tmpDir); } catch (_) { }
  }
}

async function syncAll() {
  return;
  const events = await prisma.events.findMany({
    where: {
      active: true,
      rcloneConfig: { not: null }
    }
  });

  for (const event of events) {
    await syncEvent(event);
  }

  await prisma.$disconnect();
}

module.exports = { syncEvent, syncAll, validateRcloneConfig };

if (require.main === module) {
  syncAll().catch(console.error);
}
