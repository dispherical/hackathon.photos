require('dotenv').config()
const B2 = require('backblaze-b2');
const { execSync } = require('node:child_process');
const fs = require("node:fs")
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
        console.log(folder)

        for (const fileObj of folders[folder]) {
            const fileName = fileObj.fileName
            if (fileName.includes(".rclone")) {
                const downloadRes = await b2.downloadFileByName({
                    bucketName: "hackathon-photos",
                    fileName: fileObj.fileName,
                    responseType: "arraybuffer"
                });
                const tmpFile = `/tmp/${Math.random().toString(32).slice(2)}.conf`
                var config = downloadRes.data.toString()
                config += `\n[host]
type = b2
account = ${process.env.BACKBLAZE_APPKEY_ID}
hard_delete = true
key = ${process.env.BACKBLAZE_APPKEY}`

                if (!config.includes("[guest]")) return;
                fs.writeFileSync(tmpFile, config)
                if (folder == "nova") return execSync(`rclone copy "guest:shared-album/Scrapyard NoVa" host:hackathon-photos/${folder} --config ${tmpFile}`)
                execSync(`rclone copy guest: host:hackathon-photos/${folder} --config ${tmpFile}`)
            }
        }
    }
})();