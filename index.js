require('dotenv').config()
const express = require("express");
const app = express();
const nunjucks = require("nunjucks");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const fs = require("node:fs");
const validator = require('validator');
const utils = require("./utils")
const nodemailer = require("nodemailer");
const B2 = require('backblaze-b2');
const multer = require("multer");
const os = require("node:os")
const upload = multer({ dest: os.tmpdir() });
const basicAuth = require('express-basic-auth')
const { z } = require("zod");
const { OpenAIEmbeddings } = require('@langchain/openai');
const { MemoryVectorStore } = require("langchain/vectorstores/memory")
const { Document } = require("@langchain/core/documents")
const { ChatOpenAI } = require("@langchain/openai");
const { ChatPromptTemplate } = require('@langchain/core/prompts');
const { createRetrievalChain } = require("langchain/chains/retrieval");
const { createStuffDocumentsChain } = require("langchain/chains/combine_documents");
const b2 = new B2({
    applicationKeyId: process.env.BACKBLAZE_APPKEY_ID,
    applicationKey: process.env.BACKBLAZE_APPKEY,
});
let embeddings = new OpenAIEmbeddings({
    model: "text-embedding-3-small",
    temperature: 0,
    maxRetries: 0,
    apiKey: process.env.OPENAI_API_KEY,
});

app.use(express.urlencoded({ extended: true }));
const cache = {};

async function cachedListFileNames(bucketId, prefix) {
    const cacheKey = `${bucketId}:${prefix}`;
    const cacheTTL = 5 * 60 * 1000;

    if (cache[cacheKey] && (Date.now() - cache[cacheKey].timestamp < cacheTTL)) {
        return cache[cacheKey].data;
    }

    await b2.authorize();
    const result = await b2.listFileNames({ bucketId, prefix });

    cache[cacheKey] = {
        data: result,
        timestamp: Date.now(),
    };

    return result;
}
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: 587,
    secure: false,
    auth: {
        user: process.env.EMAIL_USERNAME,
        pass: process.env.EMAIL_PASSWORD,
    },
});

app.use(express.static('photos'));
app.use(express.static('styles'));

(async () => {


    setInterval(function () { require("./exif") }, 60 * 1000 * 5)
    setInterval(function () { require("./rclone") }, 60 * 1000 * 5)

    const env = nunjucks.configure('views', {
        autoescape: true,
        express: app,
        noCache: false
    });
    env.addFilter('getExecutionTime', function (a, ms) {
        return (+new Date()) - ms
    });

    app.get("/", async function (req, res) {
        const ms = +new Date()
        res.render("index.njk", { ms });
    });
    app.get("/gallery/:id", async function (req, res) {
        const ms = +new Date();
        const id = req.params.id;
    
        const event = await prisma.events.findFirst({
            where: { id },
        });
        if (!event) return res.status(404).send("Event not found");
    
        const result = await cachedListFileNames(process.env.BACKBLAZE_BUCKET_ID, `${id}/`);
    
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        const photos = result.data.files
            .filter(file => allowedExtensions.some(ext => file.fileName.toLowerCase().endsWith(ext)))
            .map(file => `https://cdn.hackathon.photos/${file.fileName}`);
        res.render("gallery.njk", { ms, id, photos, title: event.title });
    });

    app.get("/order/:id", async function (req, res) {
        const ms = +new Date()
        const id = req.params.id

        const event = await prisma.events.findFirst({
            where: { id }
        })
        if (!event) return res.status(404).send("Event not found")

        await b2.authorize();
        const result = await cachedListFileNames(process.env.BACKBLAZE_BUCKET_ID, `${id}/`);


        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        const photos = result.data.files
            .filter(file => allowedExtensions.some(ext => file.fileName.toLowerCase().endsWith(ext)))
            .map(file => `https://cdn.hackathon.photos/${file.fileName}`);
        res.render("print.njk", { ms, id, photos, title: event.title });
    });
    async function authorizer(username, password, cb) {
        const event = await prisma.events.findFirst({
            where: { id: username }
        })
        if (!event) return cb(null, false);
        if (event.apiKey != password) return cb(null, false);

        return cb(null, true);

    }
    app.post("/admin/create", basicAuth({
        users: {
            'admin': process.env.ADMIN_PASSWORD,
        },
        challenge: true,
    }), async (req, res) => {
        const { title, apiKey, id } = req.body;
        if (!title || !apiKey || !id) return res.status(400).send("Title and API key are required.");
        await prisma.events.create({
            data: {
                id,
                title,
                apiKey
            }
        });
        res.redirect("/admin");
    });
    app.get("/admin", basicAuth({
        users: {
            'admin': process.env.ADMIN_PASSWORD,
        },
        challenge: true,
    }), async (req, res) => {
        const events = await prisma.events.findMany();
        res.render("admin.njk", { events });
    });
    app.post("/admin/:id/delete", basicAuth({
        users: {
            'admin': process.env.ADMIN_PASSWORD,
        },
        challenge: true,
    }), async (req, res) => {
        const { id } = req.params;
        await prisma.events.delete({ where: { id } });
        res.redirect("/admin");
    });
    app.get("/files/:id", basicAuth({
        authorizer: authorizer,
        authorizeAsync: true,
        challenge: true,
    }), async function (req, res) {
        const ms = +new Date()

        const { id } = req.params;

        const event = await prisma.events.findFirst({
            where: { id }
        })
        if (!event) return res.status(404).send("Event not found")
        await b2.authorize();
        const result = await b2.listFileNames({
            bucketId: process.env.BACKBLAZE_BUCKET_ID,
            prefix: `${id}/`
        });
        const files = result.data.files
        res.render("manager.njk", { ms, ...event, files });
    });

    app.post("/files/:id/upload", upload.single("file"), basicAuth({
        authorizer: authorizer,
        authorizeAsync: true,
        challenge: true,
    }), async function (req, res) {
        await b2.authorize();
        if (!req.file) return res.status(400).send("No file provided.");
        const { id } = req.params;
        const fileName = `${id}/${req.file.originalname}`;
        const data = fs.readFileSync(req.file.path);
        const uploadUrlResponse = await b2.getUploadUrl({ bucketId: process.env.BACKBLAZE_BUCKET_ID });
        await b2.uploadFile({
            bucketId: process.env.BACKBLAZE_BUCKET_ID,
            fileName,
            data,
            uploadUrl: uploadUrlResponse.data.uploadUrl,
            uploadAuthToken: uploadUrlResponse.data.authorizationToken,
        });
        fs.unlinkSync(req.file.path);
        res.redirect(`/files/${id}`);
    });


    app.get("/api/:id/search", async function (req, res) {
        const { id } = req.params;
        const { q } = req.query;

        if (!q) return res.json([]);
        
        const ResponseFormatter = z.array(
            z.object({
              image: z.string().describe("Path to the relevant image, extracted from the document"),
            })
          );
        try {
            // Fetch the EXIF data for the event
            const response = await fetch(`https://cdn.hackathon.photos/${id}/exif.json`);
            if (response.status >= 400) return res.json([]);
            const json = await response.json();

            // Prepare documents for the vector store
            const docs = json.map(document => new Document({
                pageContent: `${document.description}\n\nPath to image: ${document.image}`,
                metadata: { id: document.md5Hash, image: document.image },
            }));

            // Initialize the vector store and add documents
            const vectorStore = new MemoryVectorStore(embeddings);
            await vectorStore.addDocuments(docs);

            // Initialize the LLM and RAG chain
            const llm = new ChatOpenAI({
                modelName: "gpt-4o",
                temperature: 0,
                apiKey: process.env.OPENAI_API_KEY,

                configuration:{
                    baseURL: "https://ai.hackclub.com"
                }
            });

            const retriever = vectorStore.asRetriever();
            const prompt = ChatPromptTemplate.fromMessages([
                ["system", "You are given a description of a bunch of images. You should see which images fit the user's query. {context}"],
                ["system", "YOU MUST ALWAYS FORMAT your response like this and NEVER include any other text after that.: [{{ \"image\": \"Path to image\"}}] {context}"],
                ["human", "{input}"],
            ]);
            const questionAnswerChain = await createStuffDocumentsChain({
                llm,
                prompt,
            });
            const ragChain = await createRetrievalChain({
                retriever,
                combineDocsChain: questionAnswerChain,
            });
            const result = await ragChain.invoke({ input: q});
            res.json(JSON.parse(result.answer));
        } catch (error) {
            console.error("Error in /api/:id/search:", error);
            res.status(500).json({ error: "An error occurred while processing your request." });
        }
    });
    app.get("/files/:id/delete", basicAuth({
        authorizer: authorizer,
        authorizeAsync: true,
        challenge: true,
    }), async function (req, res) {
        await b2.authorize();
        const { id } = req.params;
        const { fileName, fileId } = req.query;
        await b2.deleteFileVersion({ fileName, fileId });
        res.redirect(`/files/${id}`);
    });
    app.get("/api/lookup", async function (req, res) {
        const ms = +new Date()
        const { q } = req.query

        if (!q) return res.status(400).send("Bad query.")
        const results = await (await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}`)).json()
        if (!results) return [];
        const { lat, lon } = results[0]
        res.json(await utils.findStore(lat, lon))
    });
    app.get("/confirm/:id", async function (req, res) {
        const ms = +new Date()
        const { id } = req.params
        const order = await prisma.order.findFirst({
            where: {
                id
            }
        })
        if (!order) return;
        if (!order.confirmed) {
            const confirmation = await utils.printPhotos(order)
            await prisma.order.update({
                where: {
                    id
                },
                data: {
                    vendorOrderId: confirmation.vendorOrderId,
                    confirmed: true
                }
            })
            res.render("confirmed.njk", { id, ...order, photoArray: order.photos.split(","), ms })
        } else {
            const confirmation = await utils.orderStatus(order.vendorOrderId)
            const status = confirmation.statuses[0]
            res.render("status.njk", { id, ...order, ...status, photoArray: order.photos.split(","), ms })
        }

    });
    app.get('/api/submit', async (req, res) => {
        var { photos, email, name, surname, tel, storeNum, promiseTime } = req.query;
        if (!photos || !email || !name || !surname || !tel || !storeNum || !promiseTime) {
            return res.status(400).json({ error: 'All fields are required.' });
        }
        if (!validator.isEmail(email)) return res.status(400).json({ error: 'Invalid E-mail' });
        if (!validator.isMobilePhone(tel, ["en-US", "en-CA"])) return res.status(400).json({ error: 'Invalid Phone Number (only US/CA phone numbers are supported)' });
        if (!validator.isJSON(photos)) return res.status(400).json({ error: 'The photos object isn\'t valid JSON.' });
        photos = JSON.parse(photos)
        const id = Math.random().toString(32).slice(2)
        await prisma.order.create({
            data: {
                id,
                photos: photos.join(","),
                firstName: name,
                lastName: surname,
                storeNumber: storeNum,
                phoneNumber: tel,
                email,
                promiseTime
            }
        })

        const info = await transporter.sendMail({
            from: '"hackathon.photos" <noreply@hackathon.photos>',
            to: email,
            subject: "Confirm your photo order",
            text: `Hi ${name} ${surname},
Before we send your order to Walgreens, we need you to confirm your E-mail address.
You may do so here: https://hackathon.photos/confirm/${id}

You have a total of ${photos.length} photo(s) pending that will be ready at ${promiseTime} if you confirm now.

N.B. You will pay at the store.`,
            html: `<style>
        body {
            font-family: system-ui, sans-serif;
            width: 100%;
            max-width: 600px;
            margin: 0 auto;
        }
        p {
            line-height: 1.5em;
        }
        .gallery {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
            gap: 10px;
        }
        .gallery img {
            width: 100%;
            height: auto;
            display: block;
        }
        @media (max-width: 600px) {
            .gallery {
                grid-template-columns: 1fr;
            }
        }
        </style>
        <h1>Confirm your photo order</h1>
        <p>Hi ${name} ${surname},</p><p>Before we send your order to Walgreens, we need you to confirm your E-mail address.</p>
        <p>You may do so here: <a href="https://hackathon.photos/confirm/${id}">https://hackathon.photos/confirm/${id}</a></p>
        <h2>Photos</h2>
        <div class="gallery">
        ${photos.map(photo => `<a href="${photo}" target="_blank"><img src="${photo}" alt="${photo}"/></a>`)}
        </div>
        <p>N.B. You will pay at the store.</p>`
        });
        res.json({ message: 'Order submitted successfully! Check your E-mail.' });
    });
    app.listen(process.env.PORT || 3000);


})();