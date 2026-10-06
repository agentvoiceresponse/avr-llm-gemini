/**
 * index.js
 * Entry point for the Gemini LLM streaming application.
 * This server handles real-time streaming of LLM responses to the client.      
 *
 * @author Agent Voice Response <info@agentvoiceresponse.com>
 * @see https://www.agentvoiceresponse.com
 */
const express = require('express');

require('dotenv').config();

const app = express();

app.use(express.json());

/**
 * Handles a prompt stream from the client and uses the Gemini API to generate
 * a response. The response is sent back to the client as a JSON object.
 *
 * @param {Object} req - The Express request object
 * @param {Object} res - The Express response object
 */
const handlePromptStream = async (req, res) => {
    const { messages } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ message: 'Messages is required' });
    }

   
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
}

app.post('/prompt-stream', handlePromptStream);

const port = process.env.PORT || 6052;
app.listen(port, () => {
    console.log(`Gemini LLM streaming listening on port ${port}`);
});
