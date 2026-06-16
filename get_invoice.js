const axios = require('axios');
require('dotenv').config();

async function getInvoice() {
    try {
        const response = await axios.get(
            `${process.env.PAPER_BASE_URL}/sales-invoices/b9278ad7-344d-44c6-99ae-266cac5da328`,
            {
                headers: {
                    'client_id': process.env.PAPER_CLIENT_ID,
                    'client_secret': process.env.PAPER_CLIENT_SECRET,
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log("INVOICE TOTAL AMOUNT:", response.data.data.totals);
        console.log("FULL DATA:", JSON.stringify(response.data.data, null, 2));
    } catch (e) {
        console.error("ERROR:", e.message);
    }
}
getInvoice();
