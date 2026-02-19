require('dotenv').config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const B2 = require('backblaze-b2');

const b2 = new B2({
    applicationKeyId: process.env.BACKBLAZE_APPKEY_ID,
    applicationKey: process.env.BACKBLAZE_APPKEY,
});

const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp', '.tiff', '.tif'];
const BUCKET_NAME = process.env.BACKBLAZE_BUCKET_NAME || "hackathon-photos";

async function migrate() {
    console.log("Starting migration from B2 listing to database...\n");

    await b2.authorize();
    const bucketId = process.env.BACKBLAZE_BUCKET_ID;

    const events = await prisma.events.findMany();
    console.log(`Found ${events.length} events in database.\n`);

    let totalMigrated = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    for (const event of events) {
        console.log(`\n── Event: "${event.title}" (${event.id}) ──`);

        let allFiles = [];
        let startFileName = null;
        do {
            const response = await b2.listFileNames({
                bucketId,
                prefix: `${event.id}/`,
                startFileName,
                maxFileCount: 1000,
            });
            allFiles = allFiles.concat(response.data.files);
            startFileName = response.data.nextFileName;
        } while (startFileName);

        const imageFiles = allFiles.filter(file => {
            const lower = file.fileName.toLowerCase();
            return ALLOWED_EXTENSIONS.some(ext => lower.endsWith(ext))
                && !lower.endsWith('exif.json')
                && !lower.endsWith('.rclone');
        });

        console.log(`   Found ${imageFiles.length} image files in B2.`);

        let oldDescriptions = {};
        const exifFile = allFiles.find(f => f.fileName === `${event.id}/exif.json`);
        if (exifFile) {
            try {
                const downloadRes = await b2.downloadFileByName({
                    bucketName: BUCKET_NAME,
                    fileName: exifFile.fileName,
                    responseType: "arraybuffer",
                });
                const exifData = JSON.parse(Buffer.from(downloadRes.data).toString());
                for (const entry of exifData) {
                    oldDescriptions[entry.image] = {
                        description: entry.description || "",
                        lat: entry.lat || null,
                        lon: entry.lon || null,
                        date: entry.date || 0,
                        md5Hash: entry.md5Hash || null,
                    };
                }
                console.log(`   Loaded ${Object.keys(oldDescriptions).length} descriptions from exif.json.`);
            } catch (e) {
                console.log(`   Could not load exif.json: ${e.message}`);
            }
        }

        let eventMigrated = 0;
        let eventSkipped = 0;

        for (const file of imageFiles) {
            const bareFileName = file.fileName.replace(`${event.id}/`, '');
            const url = `https://cdn.hackathon.photos/${file.fileName}`;

            const existing = await prisma.photo.findUnique({
                where: { eventId_fileName: { eventId: event.id, fileName: bareFileName } },
            });

            if (existing) {
                eventSkipped++;
                continue;
            }

            let description = "";
            let lat = null;
            let lon = null;
            let date = BigInt(0);

            const exifEntry = oldDescriptions[file.fileName];
            if (exifEntry) {
                description = exifEntry.description || "";
                lat = exifEntry.lat;
                lon = exifEntry.lon;
                date = BigInt(Math.floor(Number(exifEntry.date) || 0));
            }

            if (!exifEntry) {
                const oldPhoto = await prisma.$queryRawUnsafe(
                    `SELECT * FROM "Photo" WHERE "fileName" = $1 LIMIT 1`,
                    file.fileName
                );
                if (oldPhoto && oldPhoto.length > 0) {
                    const op = oldPhoto[0];
                    description = op.description || "";
                    lat = op.lat;
                    lon = op.lon;
                    date = op.date ? BigInt(op.date) : BigInt(0);
                }
            }

            try {
                await prisma.photo.create({
                    data: {
                        fileName: bareFileName,
                        url,
                        eventId: event.id,
                        description,
                        lat,
                        lon,
                        date,
                        size: file.contentLength || 0,
                        mimeType: file.contentType || "",
                    },
                });
                eventMigrated++;
            } catch (e) {
                console.error(`   Failed to migrate ${bareFileName}: ${e.message}`);
                totalFailed++;
            }
        }

        console.log(`   Migrated: ${eventMigrated}  |  Skipped (already exists): ${eventSkipped}`);
        totalMigrated += eventMigrated;
        totalSkipped += eventSkipped;
    }

    console.log(`\n${"═".repeat(50)}`);
    console.log(`Migration complete.`);
    console.log(`  Total migrated: ${totalMigrated}`);
    console.log(`  Total skipped:  ${totalSkipped}`);
    console.log(`  Total failed:   ${totalFailed}`);
    console.log(`${"═".repeat(50)}\n`);

    await prisma.$disconnect();
}

migrate().catch(e => {
    console.error("Migration failed:", e);
    process.exit(1);
});
