const { admin, db } = require('../configs/firebase-init');

const requireTicketingAdmin = async (req, res, next) => {
    const authorization = req.headers.authorization || '';
    const token = req.headers['auth-token']
        || (authorization.startsWith('Bearer ') ? authorization.slice(7) : '');

    if (!token) {
        return res.status(401).json({ message: 'Admin authentication is required.' });
    }

    try {
        const decoded = await admin.auth().verifyIdToken(token);
        const email = String(decoded.email || '').trim().toLowerCase();
        if (!email) return res.status(403).json({ message: 'Authenticated account has no email address.' });

        const whitelistSnapshot = await db.collection('whitelist').doc(email).get();
        if (!whitelistSnapshot.exists) {
            return res.status(403).json({ message: 'This account is not authorized for ticketing administration.' });
        }

        req.ticketingAdmin = { uid: decoded.uid, email };
        return next();
    } catch (error) {
        return res.status(401).json({ message: 'Admin session is invalid or expired.' });
    }
};

module.exports = { requireTicketingAdmin };
