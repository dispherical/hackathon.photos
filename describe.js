require("dotenv").config()
const { ChatOpenAI } = require("@langchain/openai")
const { HumanMessage } = require("@langchain/core/messages")
const FileType = require('file-type');
const { DeepInfraEmbeddings } = require("@langchain/community/embeddings/deepinfra");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const B2 = require('backblaze-b2');

const b2 = new B2({
  applicationKeyId: process.env.BACKBLAZE_APPKEY_ID,
  applicationKey: process.env.BACKBLAZE_APPKEY,
});

const llm = new ChatOpenAI({
  model: "nvidia/NVIDIA-Nemotron-Nano-12B-v2-VL",
  temperature: 0,
  maxRetries: 0,
  timeout: 60000,
  apiKey: process.env.DEEPINFRA_API_TOKEN,
  configuration: {
    baseURL: "https://api.deepinfra.com/v1/openai"
  }
});

const descriptorEmbeddings = new DeepInfraEmbeddings({
  apiToken: process.env.DEEPINFRA_API_TOKEN,
  modelName: process.env.EMBED_MODEL || "Qwen/Qwen3-Embedding-8B",
  batchSize: 1024,
});

async function describeImage(imageData) {
  const mimeType = await FileType.fromBuffer(imageData);
  const base64Image = imageData.toString("base64");

  const content = [
    {
      type: "text",
      text: "Describe the image in factual, detailed sentence for search indexing, explicitly stating the scene type, visible objects and their colors, people and their actions or poses and what is showing, spatial relationships (foreground/background, left/right), lighting, environment, and any readable text, without speculation or stylistic language. Output only the sentence. You should also explain what is going on. You should state what is showing from the person",
    },
    {
      type: "image_url",
      image_url: { url: `data:${mimeType.mime};base64,${base64Image}` },
    }
  ];

  const completion = await llm.invoke([new HumanMessage({ content })]);
  const description = typeof completion?.content === "string"
    ? completion.content.trim()
    : (completion?.text ?? "").trim();
  return description;
}

async function generateEmbedding(text) {
  const vector = await descriptorEmbeddings.embedQuery(text);
  const floatArray = new Float32Array(vector);
  return Buffer.from(floatArray.buffer);
}

async function reverseGeocode(lat, lon) {
  const results = await prisma.$queryRaw`
        SELECT name, "admin1Code", "countryCode",
               ("latitude" - ${lat}) * ("latitude" - ${lat}) +
               ("longitude" - ${lon}) * ("longitude" - ${lon}) AS dist
        FROM "Geoname"
        ORDER BY dist ASC
        LIMIT 1
    `;
  if (results.length === 0) return null;
  return {
    city: results[0].name,
    state: results[0].admin1Code || null,
    country: results[0].countryCode
  };
}

async function processUnembeddedPhotos() {
  const photos = await prisma.photo.findMany({
    where: {
      OR: [
        { embeddings: null },
        { description: "" },
        { city: null, lat: { not: null } },
      ],
    },
  });

  if (photos.length === 0) {
    console.log("No photos need processing.");
    return;
  }

  console.log(`Processing ${photos.length} photos...`);
  await b2.authorize();

  const CONCURRENCY = 10;
  for (let i = 0; i < photos.length; i += CONCURRENCY) {
    const batch = photos.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (photo) => {
        try {
          const needsDescription = !photo.description;
          const needsEmbeddings = !photo.embeddings;

          if (!needsDescription && !needsEmbeddings) return null;

          let description = photo.description || "";

          if (needsDescription) {
            const pathParts = photo.url.split("/");
            const b2FileName = pathParts.slice(3).join("/");

            const downloadRes = await b2.downloadFileByName({
              bucketName: process.env.BACKBLAZE_BUCKET_NAME || "hackathon-photos",
              fileName: b2FileName,
              responseType: "arraybuffer"
            });
            const imageData = Buffer.from(downloadRes.data);
            description = await describeImage(imageData);
            console.log(`Described: ${photo.fileName} -> ${description.substring(0, 80)}...`);
          }

          let embeddingsBuffer = photo.embeddings;
          if (needsEmbeddings && description) {
            embeddingsBuffer = await generateEmbedding(description);
          }

          let geo = null;
          if (!photo.city && photo.lat && photo.lon) {
            geo = await reverseGeocode(photo.lat, photo.lon);
          }

          return { photoId: photo.id, description, embeddingsBuffer, needsDescription, needsEmbeddings, geo };
        } catch (e) {
          console.error(`Skipping photo ${photo.id}: ${e.message}`);
          return null;
        }
      })
    );

    const valid = results.filter(r => r !== null);
    await Promise.all(
      valid.map(r => {
        const data = {};
        if (r.needsDescription) data.description = r.description;
        if (r.needsEmbeddings && r.embeddingsBuffer) data.embeddings = r.embeddingsBuffer;
        if (r.geo) {
          data.city = r.geo.city;
          data.state = r.geo.state;
          data.country = r.geo.country;
        }
        return prisma.photo.update({ where: { id: r.photoId }, data });
      })
    );
    console.log(`Batch ${Math.floor(i / CONCURRENCY) + 1} done.`);
  }

  await prisma.$disconnect();
}

module.exports = { describeImage, generateEmbedding, reverseGeocode, processUnembeddedPhotos };

if (require.main === module) {
  processUnembeddedPhotos().catch(console.error);
}
