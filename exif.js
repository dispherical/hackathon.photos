require('dotenv').config()
const B2 = require('backblaze-b2');
const exifParser = require('exif-parser');
const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg", ".bmp", ".ico", ".tiff", ".tif"];
const md5 = require('md5');
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const b2 = new B2({
  applicationKeyId: process.env.BACKBLAZE_APPKEY_ID,
  applicationKey: process.env.BACKBLAZE_APPKEY,
});

(async () => {
  await b2.authorize();

  const bucketId = process.env.BACKBLAZE_BUCKET_ID;

  let allFiles = [];
  let startFileName = null;
  do {
    const response = await b2.listFileNames({
      bucketId,
      startFileName,
    });
    allFiles = allFiles.concat(response.data.files);
    startFileName = response.data.nextFileName;
  } while (startFileName);

  const folders = {};
  allFiles.forEach(file => {
    const pathParts = file.fileName.split('/');
    const folder = pathParts[0];
    if (!folders[folder]) folders[folder] = [];
    folders[folder].push(file);
  });

function chunkArray(array, size) {
  const chunked = [];
  for (let i = 0; i < array.length; i += size) {
    chunked.push(array.slice(i, i + size));
  }
  return chunked;
}


for (const folder of Object.keys(folders)) {
  const exifData = [];
  const chunkedFiles = chunkArray(folders[folder], 5);

  for (const chunk of chunkedFiles) {
    const chunkResults = await Promise.all(chunk.map(async (fileObj) => {
      const ext = fileObj.fileName.split('.').pop().toLowerCase();
      if (!imageExtensions.includes(`.${ext}`)) return null;

      const downloadRes = await b2.downloadFileByName({
        bucketName: "hackathon-photos",
        fileName: fileObj.fileName,
        responseType: "arraybuffer"
      });
      const fileBuffer = Buffer.from(await downloadRes.data);
      let description;
      const md5Hash = md5(fileBuffer);
      const existingDescription = await prisma.photo.findFirst({
        where: { id: md5Hash }
      });

      if (!existingDescription) {
        const newDescription = await require("./describe")(fileBuffer);
        await prisma.photo.create({
          data: {
            id: md5Hash,
            description: newDescription.content
          }
        });
        description = newDescription.content;
      } else {
        description = existingDescription.description;
      }

      const result = exifParser.create(fileBuffer).parse();
      const lat = result.tags.GPSLatitude || '';
      const lon = result.tags.GPSLongitude || '';
      const date = result.tags.DateTimeOriginal * 1000.0 || Date.now();

      return {
        image: fileObj.fileName,
        lat,
        lon,
        date,
        description,
        md5Hash,
        event: folder
      };
    }));

    exifData.push(...chunkResults.filter(item => item !== null));
  }

  const exifJsonString = JSON.stringify(exifData);
  const uploadUrlResponse = await b2.getUploadUrl({ bucketId });
  await b2.uploadFile({
    fileName: folder + '/exif.json',
    data: Buffer.from(exifJsonString),
    bucketId,
    contentType: 'application/json',
    uploadUrl: uploadUrlResponse.data.uploadUrl,
    uploadAuthToken: uploadUrlResponse.data.authorizationToken,
  });
}
})();