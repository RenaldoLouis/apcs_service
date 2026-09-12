const axios = require('axios');
require('dotenv').config();

async function run() {
    try {
        const response = await axios.get(
            `${process.env.PAPER_BASE_URL}/sales-invoices`,
            {
                headers: {
                    'client_id': process.env.PAPER_CLIENT_ID,
                    'client_secret': process.env.PAPER_CLIENT_SECRET,
                    'Content-Type': 'application/json'
                }
            }
        );
        const invoices = response.data.invoices || [];
        console.log(`Total invoices returned: ${invoices.length}`);
        if (invoices.length > 0) {
            console.log("Most recent invoice summary:", JSON.stringify(invoices.slice(0, 3), null, 2));
        }
    } catch (e) {
        console.error("ERROR:", e.response ? e.response.data : e.message);
    }
}

run();
