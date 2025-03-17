require('dotenv').config()
const express = require("express");
const app = express();
const nunjucks = require("nunjucks");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const webdav = require('webdav-server').v2;
const fs = require("node:fs");
const validator = require('validator');
const utils = require("./utils")
const nodemailer = require("nodemailer");

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

    const events = await prisma.events.findMany({})
    const userManager = new webdav.SimpleUserManager();
    const privilegeManager = new webdav.SimplePathPrivilegeManager();

    events.forEach(event => {
        const user = userManager.addUser(event.id, event.apiKey, false);
        privilegeManager.setRights(user, `/${event.id}`, ['all']);
    })
    const server = new webdav.WebDAVServer({
        requireAuthentication: true,
        httpAuthentication: new webdav.HTTPBasicAuthentication(userManager, process.env.DOMAIN),
        privilegeManager: privilegeManager,
        rootFileSystem: new webdav.PhysicalFileSystem('./photos'),
    });
    server.afterRequest((arg, next) => {
        next();
    });

    app.use(webdav.extensions.express("/webdav", server));
    const env = nunjucks.configure('views', {
        autoescape: true,
        express: app,
        noCache: true
    });
    env.addFilter('getExecutionTime', function (a, ms) {
        return (+new Date()) - ms
    });

    app.get("/", async function (req, res) {
        const ms = +new Date()
        res.render("index.njk", { ms });
    });
    app.get("/gallery/:id", async function (req, res) {
        const ms = +new Date()
        const id = req.params.id

        const event = await prisma.events.findFirst({
            where: { id }
        })
        if (!event) return res.status(404).send("Event not found")
        const photos = fs.readdirSync(`./photos/${id}`)


        res.render("gallery.njk", { ms, id, photos, title: event.title });
    });
    app.get("/order/:id", async function (req, res) {
        const ms = +new Date()
        const id = req.params.id

        const event = await prisma.events.findFirst({
            where: { id }
        })
        if (!event) return res.status(404).send("Event not found")
        const photos = fs.readdirSync(`./photos/${id}`)


        res.render("print.njk", { ms, id, photos, title: event.title });
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
        <h2>Photos</h2>
        <div class="gallery">
        ${photos.map(photo=>`<a href="${photo}" target="_blank"><img src="${photo}" alt="${photo}"/></a>`)}
        </div>
        <p>N.B. You will pay at the store.</p>`
        });
        res.json({ message: 'Order submitted successfully! Check your E-mail.' });
    });
    app.listen(process.env.PORT || 3000);


})();