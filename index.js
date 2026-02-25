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
const { DeepInfraEmbeddings } = require("@langchain/community/embeddings/deepinfra");
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const exifParser = require('exif-parser');
const FileType = require('file-type');
const { validateRcloneConfig, syncEvent } = require("./rclone");
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const b2 = new B2({
  applicationKeyId: process.env.BACKBLAZE_APPKEY_ID,
  applicationKey: process.env.BACKBLAZE_APPKEY,
});

const descriptorEmbeddings = new DeepInfraEmbeddings({
  apiToken: process.env.DEEPINFRA_API_TOKEN,
  modelName: process.env.EMBED_MODEL || "Qwen/Qwen3-Embedding-8B",
  batchSize: 1024,
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

const adminAuth = basicAuth({
  users: { 'admin': process.env.ADMIN_PASSWORD },
  challenge: true,
});

(async () => {
  const env = nunjucks.configure('views', {
    autoescape: true,
    express: app,
    noCache: false
  });
  env.addFilter('getExecutionTime', function (a, ms) {
    return (+new Date()) - ms
  });
  env.addFilter('filesize', function (bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return `${bytes.toFixed(1)} ${units[i]}`;
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
    console.log(req.userId)
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

    const event = await prisma.events.findFirst({ where: { id } });
    if (!event) return res.status(404).send("Event not found");

    const photos = await prisma.photo.findMany({
      where: { eventId: id },
      orderBy: { date: 'asc' }
    });

    const photoUrls = photos.map(p => p.url);
    const photosWithCoords = photos.filter(p => p.lat && p.lon).map(p => ({
      url: p.url,
      lat: p.lat,
      lon: p.lon,
      date: Number(p.date),
      description: p.description
    }));

    const locationSet = new Map();
    photos.forEach(p => {
      if (p.city && p.country) {
        const key = [p.city, p.state || '', p.country].join('|');
        if (!locationSet.has(key)) {
          locationSet.set(key, { city: p.city, state: p.state || '', country: p.country, count: 0 });
        }
        locationSet.get(key).count++;
      }
    });
    const locations = Array.from(locationSet.values()).sort((a, b) => b.count - a.count);

    res.render("gallery.njk", { ms, id, photos: photoUrls, photosWithCoords: JSON.stringify(photosWithCoords), locations: JSON.stringify(locations), title: event.title });
  });

  app.get("/order/:id", async function (req, res) {
    const ms = +new Date()
    const id = req.params.id

    const event = await prisma.events.findFirst({ where: { id } });
    if (!event) return res.status(404).send("Event not found");

    const photos = await prisma.photo.findMany({
      where: { eventId: id },
      orderBy: { date: 'asc' }
    });

    const photoUrls = photos.map(p => p.url);
    res.render("print.njk", { ms, id, photos: photoUrls, title: event.title });
  });

  app.get("/admin", adminAuth, async (req, res) => {
    const events = await prisma.events.findMany({
      include: {
        _count: { select: { photos: true, eventUsers: true } },
        owner: true,
      },
      orderBy: { createdAt: 'desc' }
    });
    const requests = await prisma.eventRequest.findMany({ include: { user: true }, orderBy: { createdAt: 'desc' } });
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
    res.render("admin.njk", { events, requests, users });
  });

  app.post("/admin/create", adminAuth, async (req, res) => {
    const { title, apiKey, id } = req.body;
    if (!title || !apiKey || !id) return res.status(400).send("Title, API key, and ID are required.");
    const sanitizedId = id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    await prisma.events.create({
      data: {
        id: sanitizedId,
        title,
        apiKey,
      }
    });
    res.redirect("/admin");
  });

  app.post("/admin/requests/:id/approve", adminAuth, async (req, res) => {
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

  app.post("/admin/requests/:id/deny", adminAuth, async (req, res) => {
    const { id } = req.params;
    await prisma.eventRequest.delete({ where: { id } });
    res.redirect("/admin");
  });

  app.post("/admin/:id/delete", adminAuth, async (req, res) => {
    const { id } = req.params;
    await prisma.actionLog.deleteMany({ where: { eventId: id } });
    await prisma.photo.deleteMany({ where: { eventId: id } });
    await prisma.eventUser.deleteMany({ where: { eventId: id } });
    await prisma.events.delete({ where: { id } });
    res.redirect("/admin");
  });

  app.get("/admin/events/:id/edit", adminAuth, async (req, res) => {
    const { id } = req.params;
    const event = await prisma.events.findFirst({
      where: { id },
      include: {
        owner: true,
        eventUsers: { include: { user: true } },
        _count: { select: { photos: true } }
      }
    });
    if (!event) return res.status(404).send("Event not found");
    res.render("admin-event-edit.njk", { event });
  });

  app.post("/admin/events/:id/edit", adminAuth, async (req, res) => {
    const { id } = req.params;
    const { title, apiKey, active } = req.body;
    await prisma.events.update({
      where: { id },
      data: {
        title: title || undefined,
        apiKey: apiKey || undefined,
        active: active === 'on',
      }
    });
    res.redirect("/admin");
  });

  app.get("/files/:id", async function (req, res) {
    if (!req.userId) return res.redirect("/login");
    const { id } = req.params;
    const eventUser = await prisma.eventUser.findFirst({
      where: { eventId: id, userId: req.userId }
    });
    if (!eventUser) return res.status(403).send("Access denied");
    const event = await prisma.events.findFirst({ where: { id } });
    if (!event) return res.status(404).send("Event not found");

    const photos = await prisma.photo.findMany({
      where: { eventId: id },
      orderBy: { createdAt: 'desc' }
    });

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
      photos,
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
        const fileData = fs.readFileSync(file.path);
        const fileName = `${id}/${file.originalname}`;
        const uploadUrlResponse = await b2.getUploadUrl({ bucketId: process.env.BACKBLAZE_BUCKET_ID });

        await b2.uploadFile({
          uploadUrl: uploadUrlResponse.data.uploadUrl,
          uploadAuthToken: uploadUrlResponse.data.authorizationToken,
          fileName,
          data: fileData
        });

        let lat = null, lon = null, date = BigInt(Date.now());
        try {
          const result = exifParser.create(fileData).parse();
          if (result.tags.GPSLatitude) lat = result.tags.GPSLatitude;
          if (result.tags.GPSLongitude) lon = result.tags.GPSLongitude;
          if (result.tags.DateTimeOriginal) date = BigInt(result.tags.DateTimeOriginal * 1000);
        } catch (_) { }

        const mimeType = await FileType.fromBuffer(fileData);

        await prisma.photo.upsert({
          where: { eventId_fileName: { eventId: id, fileName: file.originalname } },
          update: {
            url: `https://cdn.hackathon.photos/${fileName}`,
            size: fileData.length,
            mimeType: mimeType?.mime || file.mimetype || "",
            lat, lon, date,
          },
          create: {
            fileName: file.originalname,
            url: `https://cdn.hackathon.photos/${fileName}`,
            eventId: id,
            size: fileData.length,
            mimeType: mimeType?.mime || file.mimetype || "",
            lat, lon, date,
          }
        });

        await prisma.actionLog.create({
          data: {
            eventId: id,
            userId: req.userId,
            action: 'upload',
            fileName: file.originalname
          }
        });

        fs.unlinkSync(file.path);
      }
      res.redirect(`/files/${id}`);
    } catch (error) {
      req.files.forEach(file => { try { fs.unlinkSync(file.path); } catch (_) { } });
      res.status(500).send("Upload failed. Please try again.");
    }
  });

  app.post("/files/:id/rclone", async (req, res) => {
    if (!req.userId) return res.redirect("/login");
    const { id } = req.params;
    const eventUser = await prisma.eventUser.findFirst({
      where: { eventId: id, userId: req.userId, role: 'admin' }
    });
    if (!eventUser) return res.status(403).send("Access denied");

    const { rcloneConfig } = req.body;

    if (rcloneConfig && rcloneConfig.trim()) {
      if (!validateRcloneConfig(rcloneConfig)) {
        return res.status(400).send("Invalid rclone config. Must contain a [guest] section, no [host] section, and no shell metacharacters.");
      }
      const event = await prisma.events.update({
        where: { id },
        data: { rcloneConfig: rcloneConfig.trim() }
      });
      syncEvent(event).catch(e => console.error(`Background sync failed: ${e.message}`));
    } else {
      await prisma.events.update({
        where: { id },
        data: { rcloneConfig: null }
      });
    }

    res.redirect(`/files/${id}`);
  });

  app.get("/api/:id/search", async function (req, res) {
    const { id } = req.params;
    const { q } = req.query;

    if (!q) return res.json([]);

    try {
      const queryVector = await descriptorEmbeddings.embedQuery(q);
      const queryFloats = new Float32Array(queryVector);

      const photos = await prisma.photo.findMany({
        where: { eventId: id, embeddings: { not: null } },
        select: { url: true, description: true, embeddings: true }
      });

      if (photos.length === 0) return res.json([]);

      const scored = photos.map(photo => {
        const storedFloats = new Float32Array(photo.embeddings.buffer, photo.embeddings.byteOffset, photo.embeddings.byteLength / 4);
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < queryFloats.length; i++) {
          dot += queryFloats[i] * storedFloats[i];
          normA += queryFloats[i] * queryFloats[i];
          normB += storedFloats[i] * storedFloats[i];
        }
        const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
        return { image: photo.url, similarity };
      });

      scored.sort((a, b) => b.similarity - a.similarity);
      const results = scored.slice(0, 20).filter(s => s.similarity > 0.3);

      res.json(results.map(r => ({ image: r.image })));
    } catch (error) {
      console.error("Search error:", error);
      res.status(500).json({ error: "Search failed." });
    }
  });

  app.get("/api/:id/filter-location", async function (req, res) {
    const { id } = req.params;
    const { city, state, country } = req.query;
    if (!city || !country) return res.json([]);
    const where = { eventId: id, city, country };
    if (state) where.state = state;
    const photos = await prisma.photo.findMany({ where, orderBy: { date: 'asc' } });
    res.json(photos.map(p => ({ image: p.url })));
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
You can verify your E-mail by using the following link: https://hackathon.photos/verify/${token}`,
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
    const { photoId } = req.query;

    const eventUser = await prisma.eventUser.findFirst({
      where: { eventId: id, userId: req.userId }
    });
    if (!eventUser) return res.status(403).send("Access denied");

    try {
      const photo = await prisma.photo.findFirst({ where: { id: photoId, eventId: id } });
      if (!photo) return res.status(404).send("Photo not found");

      await b2.authorize();
      const result = await b2.listFileNames({
        bucketId: process.env.BACKBLAZE_BUCKET_ID,
        prefix: `${id}/${photo.fileName}`,
        maxFileCount: 1
      });

      if (result.data.files.length > 0) {
        await b2.deleteFileVersion({
          fileId: result.data.files[0].fileId,
          fileName: result.data.files[0].fileName
        });
      }

      await prisma.photo.delete({ where: { id: photoId } });

      await prisma.actionLog.create({
        data: {
          eventId: id,
          userId: req.userId,
          action: 'delete',
          fileName: photo.fileName
        }
      });
    } catch (error) {
      console.error("Delete error:", error);
    }

    res.redirect(`/files/${id}`);
  });

  app.post("/files/:id/delete-bulk", express.json(), async (req, res) => {
    if (!req.userId) return res.status(401).json({ error: "Not logged in" });
    const { id } = req.params;
    const { photoIds } = req.body;
    if (!photoIds || !Array.isArray(photoIds) || photoIds.length === 0) return res.status(400).json({ error: "No photos selected" });

    const eventUser = await prisma.eventUser.findFirst({
      where: { eventId: id, userId: req.userId }
    });
    if (!eventUser) return res.status(403).json({ error: "Access denied" });

    await b2.authorize();
    let deleted = 0;
    for (const photoId of photoIds) {
      try {
        const photo = await prisma.photo.findFirst({ where: { id: photoId, eventId: id } });
        if (!photo) continue;

        const result = await b2.listFileNames({
          bucketId: process.env.BACKBLAZE_BUCKET_ID,
          prefix: `${id}/${photo.fileName}`,
          maxFileCount: 1
        });

        if (result.data.files.length > 0) {
          await b2.deleteFileVersion({
            fileId: result.data.files[0].fileId,
            fileName: result.data.files[0].fileName
          });
        }

        await prisma.photo.delete({ where: { id: photoId } });

        await prisma.actionLog.create({
          data: {
            eventId: id,
            userId: req.userId,
            action: 'delete',
            fileName: photo.fileName
          }
        });
        deleted++;
      } catch (error) {
        console.error(`Delete error for ${photoId}:`, error);
      }
    }
    res.json({ deleted });
  });

  app.get("/api/lookup", async function (req, res) {
    const ms = +new Date()
    const { q } = req.query

    if (!q) return res.status(400).send("Bad query.")
    const results = await (await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}`)).json()
    if (!results || results.length === 0) return res.json([]);
    const { lat, lon } = results[0]
    const { productId } = req.query
    res.json(await utils.findStore(lat, lon, productId))
  });

  app.get("/api/products", async function (req, res) {
    res.json(await utils.getProducts())
  });

  app.get("/confirm/:id", async function (req, res) {
    const ms = +new Date()
    const { id } = req.params
    const order = await prisma.order.findFirst({ where: { id } });
    if (!order) return res.status(404).send("Order not found");
    if (!order.confirmed) {
      const confirmation = await utils.printPhotos(order)
      await prisma.order.update({
        where: { id },
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
