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
        const inv = invoices.find(i => i.number === 'fg3w2PXSprPmuvtj7IsI');
        console.log("INVOICE fg3w2PXSprPmuvtj7IsI:", JSON.stringify(inv, null, 2));

        if (inv) {
            const detail = await axios.get(
                `${process.env.PAPER_BASE_URL}/sales-invoices/${inv.uuid}`,
                {
                    headers: {
                        'client_id': process.env.PAPER_CLIENT_ID,
                        'client_secret': process.env.PAPER_CLIENT_SECRET,
                        'Content-Type': 'application/json'
                    }
                }
            );
            console.log("INVOICE DETAIL:", JSON.stringify(detail.data, null, 2));
        }
    } catch (e) {
        console.error("ERROR:", e.response ? e.response.data : e.message);
    }
}

run();
