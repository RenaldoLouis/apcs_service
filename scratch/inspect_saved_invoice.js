const axios = require('axios');
require('dotenv').config();

async function run() {
    try {
        const response = await axios.get(
            `${process.env.PAPER_BASE_URL}/sales-invoices/68e9a5a1-ff1d-4cc1-8e5c-72ba40f5b194`,
            {
                headers: {
                    'client_id': process.env.PAPER_CLIENT_ID,
                    'client_secret': process.env.PAPER_CLIENT_SECRET,
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log("INVOICE 68e9a5a1:", JSON.stringify(response.data, null, 2));
    } catch (e) {
        console.error("ERROR:", e.response ? e.response.data : e.message);
    }
}

run();
