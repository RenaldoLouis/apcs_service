const axios = require('axios');
require('dotenv').config();

async function test(name, payload) {
    try {
        const response = await axios.post(
            `${process.env.PAPER_BASE_URL}/store-invoice`,
            payload,
            {
                headers: {
                    'client_id': process.env.PAPER_CLIENT_ID,
                    'client_secret': process.env.PAPER_CLIENT_SECRET,
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log(`✅ [${name}] SUCCESS:`, response.data?.data?.id || response.data);
    } catch (e) {
        console.log(`❌ [${name}] ERROR:`, e.response ? e.response.data : e.message);
    }
}

async function run() {
    const origPayload = {
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

    await test("With 2026 date", {
        ...origPayload,
        invoice_date: "12-09-2026",
        due_date: "15-09-2026",
        number: `INV-${Date.now()}-2026`
    });

    await test("With 2025 date", {
        ...origPayload,
        invoice_date: "12-09-2025",
        due_date: "15-09-2025",
        number: `INV-${Date.now()}-2025`
    });

    await test("With 2024 date", {
        ...origPayload,
        invoice_date: "12-09-2024",
        due_date: "15-09-2024",
        number: `INV-${Date.now()}-2024`
    });
}

run();
