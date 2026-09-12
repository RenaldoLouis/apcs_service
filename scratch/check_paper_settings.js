const axios = require('axios');
require('dotenv').config();

async function check(path) {
    try {
        const response = await axios.get(
            `${process.env.PAPER_BASE_URL}${path}`,
            {
                headers: {
                    'client_id': process.env.PAPER_CLIENT_ID,
                    'client_secret': process.env.PAPER_CLIENT_SECRET,
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log(`✅ [GET ${path}]`, response.status, response.data);
    } catch (e) {
        console.log(`❌ [GET ${path}]`, e.response?.status, e.response?.data || e.message);
    }
}

async function run() {
    await check('/webhooks');
    await check('/company');
    await check('/companies');
    await check('/settings');
}

run();
