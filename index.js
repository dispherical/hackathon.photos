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
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
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
app.use(cookieParser());

app.use(async (req, res, next) => {
    const token = req.cookies.token;
    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            req.userId = decoded.userId;
            req.user = await prisma.user.findUnique({ where: { id: decoded.userId } });
        } catch (err) {
            res.clearCookie('token');
        }
    }
    res.locals.user = req.user;
    next();
});
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


    //setInterval(function () { require("./exif") }, 60 * 1000 * 5)
    //setInterval(function () { require("./rclone") }, 60 * 1000 * 5)

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
    app.get("/register", (req, res) => {
        res.render("register.njk", { ms: +new Date() });
    });
    app.post("/register", async (req, res) => {
        const { email } = req.body;
        if (!email || !validator.isEmail(email)) return res.status(400).send("Invalid email");
        let user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
            user = await prisma.user.create({ data: { email, role: 'user' } });
        }
        const token = crypto.randomBytes(32).toString('hex');
        await prisma.magicToken.create({
            data: {
                userId: user.id,
                token,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            }
        });
        await transporter.sendMail({
            from: '"hackathon.photos" <noreply@hackathon.photos>',
            to: email,
            subject: "Verify your email",
            text: `Welcome to hackathon.photos! 
You can verify your E-mail here https://hackathon.photos/verify/${token}

Note: if you didn't request this E-mail, you can disregard it.`,
        });
        res.render("magic-sent.njk", { ms: +new Date() });
    });
    app.get("/login", (req, res) => {
        res.render("login.njk", { ms: +new Date() });
    });
    app.post("/login", async (req, res) => {
        const { email } = req.body;
        if (!email || !validator.isEmail(email)) return res.status(400).send("Invalid email");
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return res.status(400).send("User not found");
        const token = crypto.randomBytes(32).toString('hex');
        await prisma.magicToken.create({
            data: {
                userId: user.id,
                token,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            }
        });
        await transporter.sendMail({
            from: '"hackathon.photos" <noreply@hackathon.photos>',
            to: email,
            subject: "Login to hackathon.photos",
            text: `Welcome back to hackathon.photos!
Use the following link to login: https://hackathon.photos/verify/${token}`,
        });
        res.render("magic-sent.njk", { ms: +new Date() });
    });
    app.get("/verify/:token", async (req, res) => {
        const { token } = req.params;
        const magicToken = await prisma.magicToken.findUnique({ where: { token } });
        if (!magicToken || magicToken.used || magicToken.expiresAt < new Date()) return res.status(400).send("Invalid or expired token");
        const user = await prisma.user.findUnique({ where: { id: magicToken.userId } });
        if (!user) return res.status(400).send("User not found");
        await prisma.user.update({ where: { id: user.id }, data: { verified: true } });
        await prisma.magicToken.update({ where: { id: magicToken.id }, data: { used: true } });
        const jwtToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.cookie('token', jwtToken, { httpOnly: true, secure: false });
        res.redirect("/dashboard");
    });
    app.get("/dashboard", async (req, res) => {
        if (!req.userId) return res.redirect("/login");
        const user = await prisma.user.findUnique({ where: { id: req.userId } });
        const events = await prisma.eventUser.findMany({ where: { userId: req.userId }, include: { event: true } });
        res.render("dashboard.njk", { ms: +new Date(), user, events });
    });
    app.get("/logout", (req, res) => {
        res.clearCookie('token');
        res.redirect("/");
    });
    app.get("/create-event", (req, res) => {
        if (!req.userId) return res.redirect("/login");
        res.render("create-event.njk", { ms: +new Date() });
    });
    app.post("/create-event", async (req, res) => {
        if (!req.userId) return res.redirect("/login");
        const { title, apiKey } = req.body;
        if (!title || !apiKey) return res.status(400).send("Title and API key required");
        await prisma.eventRequest.create({
            data: {
                title,
                apiKey,
                requestedBy: req.userId
            }
        });
        res.redirect("/dashboard");
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
                apiKey,
                ownerId: req.userId
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
        const requests = await prisma.eventRequest.findMany({ include: { user: true } });
        res.render("admin.njk", { events, requests });
    });
    app.post("/admin/requests/:id/approve", basicAuth({
        users: {
            'admin': process.env.ADMIN_PASSWORD,
        },
        challenge: true,
    }), async (req, res) => {
        const { id } = req.params;
        const request = await prisma.eventRequest.findUnique({ where: { id } });
        if (!request) return res.status(404).send("Request not found");
        const eventId = request.title.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        await prisma.events.create({
            data: {
                id: eventId,
                title: request.title,
                apiKey: request.apiKey,
                ownerId: request.requestedBy
            }
        });
        await prisma.eventUser.create({
            data: {
                eventId,
                userId: request.requestedBy,
                role: 'admin',
                addedBy: 'admin'
            }
        });
        await prisma.eventRequest.delete({ where: { id } });
        res.redirect("/admin");
    });
    app.post("/admin/:id/delete", basicAuth({
        users: {
            'admin': process.env.ADMIN_PASSWORD,
        },
        challenge: true,
    }), async (req, res) => {
        const { id } = req.params;
        
        await prisma.actionLog.deleteMany({ where: { eventId: id } });
        await prisma.eventUser.deleteMany({ where: { eventId: id } });
        await prisma.events.delete({ where: { id } });
        
        res.redirect("/admin");
    });
    app.get("/files/:id", async function (req, res) {
        if (!req.userId) return res.redirect("/login");
        const { id } = req.params;
        const eventUser = await prisma.eventUser.findFirst({
            where: { eventId: id, userId: req.userId }
        });
        if (!eventUser) return res.status(403).send("Access denied");
        const event = await prisma.events.findFirst({
            where: { id },
        });
        if (!event) return res.status(404).send("Event not found");
        await b2.authorize();
        const result = await b2.listFileNames({
            bucketId: process.env.BACKBLAZE_BUCKET_ID,
            prefix: `${id}/`
        });
        const files = result.data.files;
        
        let users = [];
        let auditLogs = [];
        if (eventUser.role === 'admin' || req.userId === event.ownerId) {
            users = await prisma.eventUser.findMany({
                where: { eventId: id },
                include: { user: true }
            });
            auditLogs = await prisma.actionLog.findMany({
                where: { eventId: id },
                include: { user: true },
                orderBy: { createdAt: 'desc' },
                take: 100
            });
        }
        
        res.render("manager.njk", { 
            ms: +new Date(), 
            ...event, 
            files, 
            userRole: eventUser.role,
            isOwner: req.userId === event.ownerId,
            users,
            auditLogs
        });
    });

    app.post("/files/:id/upload", upload.array("files", 50), async function (req, res) {
        if (!req.userId) return res.redirect("/login");
        const { id } = req.params;
        const eventUser = await prisma.eventUser.findFirst({
            where: { eventId: id, userId: req.userId }
        });
        if (!eventUser) return res.status(403).send("Access denied");
        await b2.authorize();
        if (!req.files || req.files.length === 0) return res.status(400).send("No files provided.");
        try {
            for (const file of req.files) {
                const fileName = `${id}/${file.originalname}`;
                const uploadUrlResponse = await b2.getUploadUrl({ bucketId: process.env.BACKBLAZE_BUCKET_ID });
                
                await b2.uploadFile({
                    uploadUrl: uploadUrlResponse.data.uploadUrl,
                    uploadAuthToken: uploadUrlResponse.data.authorizationToken,
                    fileName,
                    data: fs.readFileSync(file.path)
                });
                
                await prisma.actionLog.create({
                    data: {
                        eventId: id,
                        userId: req.userId,
                        action: 'add',
                        fileName
                    }
                });
            }
            res.redirect(`/files/${id}`);
        } catch (error) {
            req.files.forEach(file => fs.unlinkSync(file.path));
            //console.error("Upload error:", error);
            res.status(500).send("Upload failed. Please try again.");
        }
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
            const response = await fetch(`https://cdn.hackathon.photos/${id}/exif.json`);
            if (response.status >= 400) return res.json([]);
            const json = await response.json();

            const docs = json.map(document => new Document({
                pageContent: `${document.description}\n\nPath to image: ${document.image}`,
                metadata: { id: document.md5Hash, image: document.image },
            }));

            const vectorStore = new MemoryVectorStore(embeddings);
            await vectorStore.addDocuments(docs);

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
            console.log(result.answer.replace(/<think>[\s\S]*?<\/think>/, '').trim())
            res.json(JSON.parse(result.answer.replace(/<think>[\s\S]*?<\/think>/, '').trim()));
        } catch (error) {
            console.error("Error in /api/:id/search:", error);
            res.status(500).json({ error: "An error occurred while processing your request." });
        }
    });
    app.post("/files/:id/invite", async (req, res) => {
        if (!req.userId) return res.redirect("/login");
        const { id } = req.params;
        const eventUser = await prisma.eventUser.findFirst({
            where: { eventId: id, userId: req.userId, role: 'admin' }
        });
        if (!eventUser) return res.status(403).send("Access denied");
        const { email } = req.body;
        if (!email || !validator.isEmail(email)) return res.status(400).send("Invalid email");
        let user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
            user = await prisma.user.create({ data: { email, role: 'user' } });
        }
        const existing = await prisma.eventUser.findFirst({ where: { eventId: id, userId: user.id } });
        if (existing) return res.status(400).send("User already invited");
        await prisma.eventUser.create({
            data: {
                eventId: id,
                userId: user.id,
                role: 'viewer',
                addedBy: req.userId
            }
        });
        const token = crypto.randomBytes(32).toString('hex');
        await prisma.magicToken.create({
            data: {
                userId: user.id,
                token,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            }
        });
        await transporter.sendMail({
            from: '"hackathon.photos" <noreply@hackathon.photos>',
            to: email,
            subject: "You've been invited to manage photos",
            text: `You've been invited to view files on hackathon.photos
You van verify your E-mail by using the following link: https://hackathon.photos/verify/${token}`,
        });
        res.redirect(`/files/${id}`);
    });
    
    app.post("/files/:id/users/:userId/role", async (req, res) => {
        if (!req.userId) return res.redirect("/login");
        const { id, userId } = req.params;
        const { role } = req.body;
        
        const event = await prisma.events.findFirst({ where: { id } });
        if (!event) return res.status(404).send("Event not found");
        
        const currentUserEvent = await prisma.eventUser.findFirst({
            where: { eventId: id, userId: req.userId }
        });
        
        if (!currentUserEvent || (currentUserEvent.role !== 'admin' && req.userId !== event.ownerId)) {
            return res.status(403).send("Access denied");
        }
        
        if (!['viewer', 'admin'].includes(role)) {
            return res.status(400).send("Invalid role");
        }
        
        await prisma.eventUser.updateMany({
            where: { eventId: id, userId },
            data: { role }
        });
        
        await prisma.actionLog.create({
            data: {
                eventId: id,
                userId: req.userId,
                action: `role_change_to_${role}`,
                fileName: `user_${userId}`
            }
        });
        
        res.redirect(`/files/${id}`);
    });
    
    app.post("/files/:id/users/:userId/remove", async (req, res) => {
        if (!req.userId) return res.redirect("/login");
        const { id, userId } = req.params;
        
        const event = await prisma.events.findFirst({ where: { id } });
        if (!event) return res.status(404).send("Event not found");
        
        const currentUserEvent = await prisma.eventUser.findFirst({
            where: { eventId: id, userId: req.userId }
        });
        
        if (!currentUserEvent || (currentUserEvent.role !== 'admin' && req.userId !== event.ownerId)) {
            return res.status(403).send("Access denied");
        }
        
        if (userId === event.ownerId) {
            return res.status(400).send("Cannot remove event owner");
        }
        
        const removedUser = await prisma.eventUser.findFirst({
            where: { eventId: id, userId },
            include: { user: true }
        });
        
        await prisma.eventUser.deleteMany({
            where: { eventId: id, userId }
        });
        
        await prisma.actionLog.create({
            data: {
                eventId: id,
                userId: req.userId,
                action: 'user_removed',
                fileName: `user_${userId}_${removedUser?.user?.email || 'unknown'}`
            }
        });
        
        res.redirect(`/files/${id}`);
    });
    
    app.get("/files/:id/delete", async (req, res) => {
        if (!req.userId) return res.redirect("/login");
        const { id } = req.params;
        const { fileName, fileId } = req.query;
        
        const eventUser = await prisma.eventUser.findFirst({
            where: { eventId: id, userId: req.userId }
        });
        if (!eventUser) return res.status(403).send("Access denied");
        
        try {
            await b2.authorize()
            await b2.deleteFileVersion({
                fileId,
                fileName
            });
            
            await prisma.actionLog.create({
                data: {
                    eventId: id,
                    userId: req.userId,
                    action: 'delete',
                    fileName
                }
            });
            
        } catch (error) {
            console.error("Delete error:", error);
        }
        
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
