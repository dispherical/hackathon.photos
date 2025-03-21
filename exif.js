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
  const chunkedFiles = chunkArray(folders[folder], 20);

  for (const chunk of chunkedFiles) {
    const chunkResults = await Promise.all(chunk.map((fileObj) => {
      return (async () => {
        const ext = fileObj.fileName.split('.').pop().toLowerCase();
        if (!imageExtensions.includes(`.${ext}`)) return null;
        
        const existingPhoto = await prisma.photo.findFirst({
          where: { fileName: fileObj.fileName }
        });
        if (existingPhoto) {
          console.log(`File already processed: ${fileObj.fileName}`);
          return {
            image: fileObj.fileName,
            lat: existingPhoto.lat,
            lon: existingPhoto.lon,
            date: existingPhoto.date,
            description: existingPhoto.description,
            md5Hash: existingPhoto.id,
            event: folder
          };
        }
    
        console.log(`Downloading file: ${fileObj.fileName}`);
        const downloadRes = await b2.downloadFileByName({
          bucketName: "hackathon-photos",
          fileName: fileObj.fileName,
          responseType: "arraybuffer"
        });
        const fileBuffer = Buffer.from(await downloadRes.data);
        const md5Hash = md5(fileBuffer);
    
        console.log(`Generating description for ${fileObj.fileName}`);
        const newDescription = await require("./describe")(fileBuffer);
        const result = exifParser.create(fileBuffer).parse();
        const lat = result.tags.GPSLatitude;
        const lon = result.tags.GPSLongitude;
        const date = result.tags.DateTimeOriginal * 1000.0 || Date.now();
    
        const existingPhotoById = await prisma.photo.findUnique({
          where: { id: md5Hash }
        });
        
        if (!existingPhotoById) {
          await prisma.photo.create({
            data: {
              id: md5Hash,
              fileName: fileObj.fileName,
              description: newDescription.content,
              lat,
              lon,
              date
            }
          });
        } else {
          console.log(`Photo with ID ${md5Hash} already exists.`);
        }
    
        console.log(`Generated description for ${fileObj.fileName}`);
        return {
          image: fileObj.fileName,
          lat,
          lon,
          date,
          description: newDescription.content,
          md5Hash,
          event: folder
        };
      })();
    }));

    exifData.push(...chunkResults.filter(item => item !== null));
  }

  const exifJsonString = JSON.stringify(
    exifData.map(item => ({
      ...item,
      date: typeof item.date === 'bigint' ? Number(item.date) : item.date,
    }))
  );
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