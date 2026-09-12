const axios = require('axios');
require('dotenv').config();

async function testPost(endpoint, payload) {
    try {
        const response = await axios.post(
            `${process.env.PAPER_BASE_URL}${endpoint}`,
            payload,
            {
                headers: {
                    'client_id': process.env.PAPER_CLIENT_ID,
                    'client_secret': process.env.PAPER_CLIENT_SECRET,
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log(`✅ [POST ${endpoint}] SUCCESS (${response.status}):`, response.data);
    } catch (e) {
        console.log(`❌ [POST ${endpoint}] ERROR (${e.response?.status}):`, e.response ? e.response.data : e.message);
    }
}

async function run() {
    const payload = {
        invoice_date: "12-09-2026",
        due_date: "15-09-2026",
        number: `INV-${Date.now()}`,
        customer: {
            id: `TEST-${Date.now()}`,
            name: "Renaldo Test",
            email: "renaldo.louis555@gmail.com",
            phone: "08123456789"
        },
        items: [{
            name: "Piano Solo",
            description: "APCS Registration",
            quantity: 1,
            price: 10000,
            discount: 0,
            tax_id: ""
        }],
        signature_text_header: "12-09-2026",
        signature_text_footer: "APCS Committee",
        terms_condition: "Please complete payment within 3 days.",
        notes: "Thank you for registering with APCS.",
        send: {
            email: false,
            whatsapp: false,
            sms: false
        }
    };

    await testPost('/sales-invoices', payload);
    await testPost('/sales-invoice', payload);
}

run();
