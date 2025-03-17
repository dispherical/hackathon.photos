const fs = require('fs');
const path = require('path');
const exifParser = require('exif-parser');

const photosDir = path.join(__dirname, 'photos');
const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg", ".bmp", ".ico", ".tiff", ".tif"];

const folders = fs.readdirSync(photosDir);

folders.forEach(folder => {
    const folderPath = path.join(photosDir, folder);
    const files = fs.readdirSync(folderPath);

    const exifData = [];

    files.forEach(file => {
        const filePath = path.join(folderPath, file);
        if (imageExtensions.includes(path.extname(file).toLowerCase())) {
            const result = exifParser.create(fs.readFileSync(filePath)).parse()

            const lat = result.tags.GPSLatitude || '';
            const lon = result.tags.GPSLongitude || '';
            const date = result.tags.DateTimeOriginal * 1000.0 || fs.statSync(filePath).birthtime
            if (!lat || !lon || !date) return;
            exifData.push({
                image: file,
                lat,
                lon,
                date
            });
        }
    });

    const exifJsonPath = path.join(folderPath, 'exif.json');
    fs.writeFileSync(exifJsonPath, JSON.stringify(exifData));
});