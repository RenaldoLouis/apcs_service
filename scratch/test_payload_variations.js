const axios = require('axios');
require('dotenv').config();

const BASE_URL = process.env.PAPER_BASE_URL;
const HEADERS = {
    'client_id': process.env.PAPER_CLIENT_ID,
    'client_secret': process.env.PAPER_CLIENT_SECRET,
    'Content-Type': 'application/json'
};

async function test(label, payload) {
    try {
        const res = await axios.post(`${BASE_URL}/store-invoice`, payload, {
            headers: HEADERS,
            timeout: 8000
        });
        console.log(`✅ [${label}] SUCCESS:`, res.status, res.data?.data?.id || res.data?.data?.number);
        return true;
    } catch (e) {
        const data = e.response?.data;
        const msg = data?.error?.message || data?.message || e.message;
        console.log(`❌ [${label}] FAILED (${e.response?.status}):`, typeof data === 'object' ? JSON.stringify(data) : data || msg);
        return false;
    }
}

async function run() {
    const base = {
        invoice_date: "12-09-2026",
        due_date: "15-09-2026",
        number: `TEST-VAR-${Date.now()}`,
        customer: {
            name: "Test User",
            email: "test@example.com",
            phone: "08123456789"
        },
        items: [{
            name: "Ticket Test",
            quantity: 1,
            price: 10000
        }]
    };

    console.log("--- TEST 1: Minimal without customer.id and without send ---");
    await test("minimal", { ...base, number: `T1-${Date.now()}` });

    console.log("--- TEST 2: Without send, but with customer.id ---");
    await test("with customer.id", { ...base, number: `T2-${Date.now()}`, customer: { id: "test-cust-id", ...base.customer } });

    console.log("--- TEST 3: Without items array, empty or different ---");
    await test("no discount/tax items", {
        ...base,
        number: `T3-${Date.now()}`,
        items: [{
            name: "Ticket",
            description: "Desc",
            quantity: 1,
            price: 10000,
            discount: 0,
            tax_id: null
        }]
    });

    console.log("--- TEST 4: Without send field entirely ---");
    await test("no send field", {
        invoice_date: "12-09-2026",
        due_date: "15-09-2026",
        number: `T4-${Date.now()}`,
        customer: {
            name: "Test User",
            email: "test4@example.com",
            phone: "081234567890"
        },
        items: [{
            name: "Item 1",
            price: 10000,
            quantity: 1
        }]
    });
}

run();
