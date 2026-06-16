const axios = require('axios');
require('dotenv').config();

async function testDiscount() {
    const payload = {
        invoice_date: "16-06-2026",
        due_date: "17-06-2026",
        number: "TEST-DISC-" + Date.now(),
        customer: {
            id: "test-user-id",
            name: "Test User",
            email: "test@example.com",
            phone: "081234567890"
        },
        items: [
            {
                name: "Test Item",
                description: "Testing discount logic",
                quantity: 5,
                price: 100,
                discount: 25,
                discount_type: "amount",
                tax_id: ""
            }
        ],
        notes: "Test",
        send: { email: false, whatsapp: false, sms: false }
    };

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
        console.log("SUCCESS:", JSON.stringify(response.data.data, null, 2));
    } catch (e) {
        console.error("ERROR:", JSON.stringify(e.response ? e.response.data : e.message, null, 2));
    }
}
testDiscount();
