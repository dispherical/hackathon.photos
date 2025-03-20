require("dotenv").config()
const { ChatOpenAI } = require("@langchain/openai")
const { HumanMessage, SystemMessage } = require("@langchain/core/messages")
const FileType = require('file-type');

module.exports = async function main(imageData) {
    let llm = new ChatOpenAI({
        model: "meta-llama/Llama-3.2-11B-Vision-Instruct",
        temperature: 0,
        maxRetries: 0,
        apiKey: process.env.DEEPINFRA_API_TOKEN,
        configuration: {
            baseURL: "https://api.deepinfra.com/v1/openai"
        }
    });

    const humanMessageLoader = [{
        type: "text",
        text: "Explain what is going on the image. Include objects and their colors and people and what they are doing including their poses. Try to be somewhat detailed so the search engine can pick up on keywords.",
    }]
    const messages = [
        new SystemMessage("This will be used in an image search engine. Include objects, background, etc which will allow the user to find images easily."),
        new HumanMessage({ content: humanMessageLoader })
    ];

    const mimeType = await FileType.fromBuffer(imageData)
    const base64Image = imageData.toString("base64");
    humanMessageLoader.push({
        type: "image_url",
        image_url: {
            url: `data:${mimeType.mime};base64,${base64Image}`
        }
    })

    let completion = await llm.invoke(messages);
    return { content: completion.content }
}
