import fs from "fs";
import path from "path";
import { Client } from "pg";
import copyFrom from "pg-copy-streams";

const FILE_PATH = path.resolve("data/cities500.txt");

const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  await client.connect();
  console.log("Connected");
  await client.query(`
    CREATE TABLE IF NOT EXISTS geoname_staging
    (LIKE "Geoname" INCLUDING DEFAULTS);
  `);

  await client.query(`TRUNCATE geoname_staging`);

  console.log("Copying into staging...");

  const copyStream = client.query(
    copyFrom.from(`
      COPY geoname_staging (
        "geonameId",
        "name",
        "asciiName",
        "alternateNames",
        "latitude",
        "longitude",
        "featureClass",
        "featureCode",
        "countryCode",
        "cc2",
        "admin1Code",
        "admin2Code",
        "admin3Code",
        "admin4Code",
        "population",
        "elevation",
        "dem",
        "timezone",
        "modificationDate"
      )
      FROM STDIN
      WITH (
        FORMAT text,
        DELIMITER E'\\t',
        NULL '',
        ENCODING 'UTF8'
      )
    `)
  );

  fs.createReadStream(FILE_PATH).pipe(copyStream);

  await new Promise((resolve, reject) => {
    copyStream.on("finish", resolve);
    copyStream.on("error", reject);
  });

  console.log("Merging...");

  await client.query(`
    INSERT INTO "Geoname"
    SELECT *
    FROM geoname_staging
    ON CONFLICT ("geonameId") DO NOTHING;
  `);

  console.log("Cleaning up...");
  await client.query(`TRUNCATE geoname_staging`);

  console.log("Import complete");
  await client.end();
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
