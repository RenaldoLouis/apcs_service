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
        console.log(`Total: ${invoices.length}`);
        invoices.forEach((inv, i) => {
            console.log(`[${i}] number: ${inv.number}, created_at: ${inv.created_at}, updated_at: ${inv.updated_at}, totals: ${inv.totals?.grandTotal}`);
        });
    } catch (e) {
        console.error("ERROR:", e.response ? e.response.data : e.message);
    }
}

run();
