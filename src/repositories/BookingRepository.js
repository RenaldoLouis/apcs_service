const pool = require('../configs/DbConfig');
const { logger } = require('../utils/Logger');
const { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const archiver = require('archiver');
const { AppendFilesToZip } = require('../utils/awsDownload');
const axios = require('axios');
const { db, admin } = require('../configs/firebase-init');

// Get QRIS credentials securely from your .env file
const QRIS_API_URL = "https://qris.interactive.co.id/api/v1"; // Use the actual production URL
const QRIS_API_KEY = process.env.QRIS_API_KEY;
const QRIS_API_SECRET = process.env.QRIS_API_SECRET;

const createBooking = async (body, callback) => {
    const { eventId, userEmail, ticketQuantity, selectedSeatIds, selectedAddOnIds, isPublic, publicUserName, publicUserPhone, complimentaryTickets, orchestraSessionId } = body;

    // --- Define refs outside the try block to have access in the catch block ---
    let bookingRef = null;

    try {
        // --- 1. Validation ---
        if (!eventId || !userEmail || (ticketQuantity === undefined && complimentaryTickets === undefined)) {
            throw new Error("Missing required booking information.");
        }
        let regularTicketQuantity = ticketQuantity || 0;
        let complimentaryCount = complimentaryTickets ? parseInt(complimentaryTickets) : 0;
        
        if (regularTicketQuantity === 0 && complimentaryCount === 0) {
            throw new Error("No tickets selected.");
        }

        if (selectedSeatIds && selectedSeatIds.length !== regularTicketQuantity) {
            callback(null, { message: "Number of selected seats must match regular ticket quantity." })
        }

        let customerRef = null;
        if (isPublic) {
             if (!publicUserName || !publicUserPhone) {
                  throw new Error("Missing public user information.");
             }
             customerRef = db.collection("customers").doc();
        }

        // --- 2. Securely Fetch Pricing Rules & Re-Calculate Price ---
        const eventRef = db.collection('events').doc(eventId);
        const eventDoc = await eventRef.get();
        if (!eventDoc.exists) {
            throw new Error("Event not found.");
            // callback(null, { message: "Event not found." })

        }
        const eventData = eventDoc.data();

        // (Calculation logic is the same)
        const items = [];
        let calculatedTotal = 0;

        if (complimentaryCount > 0) {
            items.push({ type: "ticket", description: "Complimentary Orchestra Admission", quantity: complimentaryCount, price: 0 });
        }

        // Base tickets
        if (regularTicketQuantity > 0) {
            calculatedTotal += eventData.baseTicketPrice * regularTicketQuantity;
            items.push({ type: "ticket", description: "General Admission", quantity: regularTicketQuantity, price: eventData.baseTicketPrice * regularTicketQuantity });
        }

        // Selected seats
        if (selectedSeatIds && selectedSeatIds.length > 0) {
            for (const seatId of selectedSeatIds) {
                const seatDoc = await db.collection('seats').doc(seatId).get();
                const seatData = seatDoc.data();
                const seatPrice = eventData.pricingTiers[seatData.areaType]?.[seatData.rowType] || 0;
                calculatedTotal += seatPrice;
                items.push({ type: "seat", description: `Seat ${seatData.seatLabel}`, seatId, price: seatPrice });
            }
        }

        // Add-ons
        if (selectedAddOnIds && selectedAddOnIds.length > 0) {
            for (const addOnId of selectedAddOnIds) {
                const addOnData = eventData.addOns.find(a => a.id === addOnId);
                if (addOnData) {
                    calculatedTotal += addOnData.price;
                    items.push({ type: "addOn", description: addOnData.name, id: addOnId, price: addOnData.price });
                }
            }
        }
        // --- 3. Run Firestore Transaction ---
        console.log("Starting Firestore transaction to lock seats...");
        bookingRef = db.collection("bookings").doc();
        await db.runTransaction(async (transaction) => {
            // Check and update complimentary quota if requested
            if (complimentaryCount > 0) {
                const currentEventDoc = await transaction.get(eventRef);
                const currentEventData = currentEventDoc.data();
                const currentSessionIndex = currentEventData.orchestraSessions?.findIndex(s => s.id === orchestraSessionId);
                
                if (currentSessionIndex === -1 || currentSessionIndex === undefined) {
                    throw new Error("Orchestra session not found.");
                }
                
                const currentSession = currentEventData.orchestraSessions[currentSessionIndex];
                const quota = currentSession.complimentaryQuota || 0;
                const claimed = currentSession.complimentaryClaimed || 0;
                
                if (claimed + complimentaryCount > quota) {
                    throw new Error("Not enough complimentary quota left for this session.");
                }
                
                // Update the claimed amount
                const updatedSessions = [...currentEventData.orchestraSessions];
                updatedSessions[currentSessionIndex] = {
                    ...currentSession,
                    complimentaryClaimed: claimed + complimentaryCount
                };
                transaction.update(eventRef, { orchestraSessions: updatedSessions });
            }

            if (selectedSeatIds && selectedSeatIds.length > 0) {
                for (const seatId of selectedSeatIds) {
                    const seatRef = db.collection("seats").doc(seatId);
                    const seatDoc = await transaction.get(seatRef);
                    if (seatDoc.data().status !== 'available') {
                        throw new Error(`Seat ${seatDoc.data().seatLabel} is no longer available.`);
                    }
                    transaction.update(seatRef, { status: 'locked' });
                }
            }
            transaction.set(bookingRef, {
                eventId, userEmail, status: "pending", items,
                summary: { totalPrice: calculatedTotal },
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                checkedIn: false,
                isPublic: isPublic ? true : false,
                orchestraSessionId: orchestraSessionId || null,
                ...(customerRef && { customerId: customerRef.id })
            });

            if (customerRef) {
                transaction.set(customerRef, {
                    name: publicUserName,
                    email: userEmail,
                    phone: publicUserPhone,
                    eventId: eventId,
                    bookingId: bookingRef.id,
                    orchestraSessionId: orchestraSessionId || null,
                    paymentStatus: "pending",
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        });
        console.log("Firestore transaction successful. Seats are locked.");

        // --- 4. Call QRIS API ---
        // console.log("Calling QRIS API...");
        // const qrisPayload = {
        //     api_key: process.env.QRIS_API_KEY, secret_key: process.env.QRIS_API_SECRET,
        //     merchant_ref: bookingRef.id, amount: calculatedTotal,
        // };
        // const qrisResponse = await axios.post(process.env.QRIS_API_URL, qrisPayload);
        // if (qrisResponse.data.status !== 'success') {
        //     // This will be caught by our catch block below
        //     throw new Error(qrisResponse.data.message || "Failed to create QRIS invoice.");
        // }
        // console.log("QRIS API call successful.");

        // Update booking with QRIS invoice ID (using mock or actual if un-commented)
        if (typeof qrisResponse !== 'undefined' && qrisResponse && qrisResponse.data) {
            await bookingRef.update({ qrisInvoiceId: qrisResponse.data.invoice_id });
        }

        // --- 5. Return the final data ---
        // res.status(201).json({
        //     message: "Booking initiated successfully!",
        //     bookingId: bookingRef.id,
        //     qrisString: qrisResponse.data.qris_string,
        // });
        callback(null, {
            message: "Booking initiated successfully!",
            bookingId: bookingRef.id,
            qrisString: (typeof qrisResponse !== 'undefined' && qrisResponse && qrisResponse.data) ? qrisResponse.data.qris_string : "MOCK_QRIS_STRING",
        })

    } catch (error) {
        console.error("Booking failed:", error.message);

        // --- THIS IS THE CRUCIAL ROLLBACK LOGIC ---
        // If the error happened after seats were locked, we unlock them.
        if (selectedSeatIds && selectedSeatIds.length > 0) {
            console.log("An error occurred. Rolling back locked seats...");
            // Use Promise.all to run all updates in parallel
            const unlockPromises = selectedSeatIds.map(seatId => {
                const seatRef = db.collection("seats").doc(seatId);
                return seatRef.update({ status: "available" });
            });
            await Promise.all(unlockPromises);
            console.log("Rollback complete. Seats have been unlocked.");
        }

        // If the booking document was created, we can also update its status to 'failed'
        if (bookingRef && (await bookingRef.get()).exists) {
            await bookingRef.update({ status: 'failed', error: error.message });
        }

        // Re-throw the error so the controller can send a 500 response
        callback(error)
    }
}

//UNUSED API WHEN TESTING FOR PAYMENT INTEGRATION
const getBookingStatus = async (params, res) => {
    try {
        const { bookingId } = params;

        const bookingRef = db.collection('bookings').doc(bookingId);
        const doc = await bookingRef.get();

        if (!doc.exists) {
            return res.status(404).json({ message: "Booking not found." });
        }

        const bookingData = doc.data();

        // Check our database first. If it's already paid, just return that.
        if (bookingData.status === 'paid') {
            return res.status(200).json({ status: 'paid' });
        }

        // If not paid, check with QRIS API
        const qrisPayload = {
            api_key: QRIS_API_KEY, secret_key: QRIS_API_SECRET,
            invoice_id: bookingData.qrisInvoiceId,
        };
        const statusResponse = await axios.post(`${QRIS_API_URL}/check-status`, qrisPayload);

        const qrisStatus = statusResponse.data.status; // e.g., 'paid', 'pending', 'expired'

        if (qrisStatus === 'paid') {
            // IMPORTANT: Payment confirmed! Update our database and trigger email.
            await bookingRef.update({ status: 'paid' });
            if (bookingData.customerId) {
                await db.collection('customers').doc(bookingData.customerId).update({ paymentStatus: 'paid' });
            }
            // await emailService.sendTicketEmail(bookingId); // You would call your email service here
        }

        res.status(200).json({ status: qrisStatus });

    } catch (error) {
        console.error("Status check failed:", error);
        res.status(500).json({ message: error.message || "Could not check booking status." });
    }
};


module.exports = {
    createBooking,
    getBookingStatus
}