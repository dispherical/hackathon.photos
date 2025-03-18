require('dotenv').config()
const B2 = require('backblaze-b2');
const exifParser = require('exif-parser');
const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg", ".bmp", ".ico", ".tiff", ".tif"];

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

  for (const folder of Object.keys(folders)) {
    const exifData = [];
    for (const fileObj of folders[folder]) {
      const ext = fileObj.fileName.split('.').pop().toLowerCase();
      if (!imageExtensions.includes(`.${ext}`)) continue;

     
      const downloadRes = await b2.downloadFileByName({
        bucketName: "hackathon-photos"      ,  
        fileName: fileObj.fileName,
        responseType: "arraybuffer"
      });
      const fileBuffer = Buffer.from(await downloadRes.data);

      const result = exifParser.create(fileBuffer).parse();
      const lat = result.tags.GPSLatitude || '';
      const lon = result.tags.GPSLongitude || '';
      const date = result.tags.DateTimeOriginal * 1000.0 || Date.now();
      if (!lat || !lon || !date) continue;

      exifData.push({
        image: fileObj.fileName,
        lat,
        lon,
        date
      });
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