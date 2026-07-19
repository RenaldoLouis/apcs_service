const express = require('express')
const router = express.Router();
const paymentController = require("../controllers/PaymentController");
const EmailController = require("../controllers/EmailController");
const FirebaseController = require("../controllers/FirebaseController");
const RegisterController = require("../controllers/RegisterController");
const JuryController = require("../controllers/JuryController");
const BookingController = require("../controllers/BookingController");
const TicketController = require('../controllers/TicketController')

const rateLimit = require('express-rate-limit')

const registerLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 5, message: { error: 'Too many registration attempts, please try again later.' } })
const initUploadLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 10, message: { error: 'Too many upload initiations, please try again later.' } })
const partUploadLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 300, message: { error: 'Too many chunk uploads, please try again later.' } })
const completeUploadLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 10, message: { error: 'Too many complete requests, please try again later.' } })
const signedUrlLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 30, message: { error: 'Too many signed URL requests, please try again later.' } });
const PublicTicketController = require("../controllers/PublicTicketController");
const SystemSettingsController = require("../controllers/SystemSettingsController");
const { paymentValidation } = require('../utils/ValidationUtil');
const { multipartUploadValidation, partUploadValidation, completeUploadValidation, abortUploadValidation } = require('../middlewares/ValidationMiddleware');

router.post('/createPayment', paymentValidation, paymentController.createPayment)

router.post('/sendEmail', EmailController.sendEmail)
router.post('/sendEmailFail', EmailController.sendEmailFail)
router.post('/sendEmailAnnouncement', EmailController.sendEmailAnnouncement)
router.post('/sendEmailAnnouncementJson', EmailController.sendEmailAnnouncementJson)
router.post('/sendEmailSessionWinner', EmailController.sendEmailSessionWinner)
router.post('/sendEmailPaymentRequest', EmailController.sendEmailPaymentRequest)
router.post('/sendSeatBookingEmail', EmailController.sendSeatBookingEmail)
router.post('/sendGeneralSeatingEmail', EmailController.sendGeneralSeatingEmail);
router.post('/sendTeamEntryPassEmail', EmailController.sendTeamEntryPassEmail);
router.post('/sendSponsorEntryPassEmail', EmailController.sendSponsorEntryPassEmail);
router.post('/sendEmailNotifyApcs', EmailController.sendEmailNotifyApcs)
router.post('/sendEmailNotifyBulkUpdateRegistrant', EmailController.sendEmailNotifyBulkUpdateRegistrant)
router.post('/sendEmailStageReschedule', EmailController.sendEmailStageReschedule)
router.post('/sendEmailGalaConcertUpdate', EmailController.sendEmailGalaConcertUpdate)
router.post('/sendEmailGalaWinnerAnnouncement', EmailController.sendEmailGalaWinnerAnnouncement)
router.post('/sendEmailPerformanceInvitation', EmailController.sendEmailPerformanceInvitation)
router.post('/sendEmailSoundOfAsia2026Invite', EmailController.sendEmailSoundOfAsia2026Invite)

const PaperController = require("../controllers/PaperController");
router.post('/resendConfirmationEmail', PaperController.resendConfirmationEmail)


router.get('/getGaleries', FirebaseController.getGaleries)
router.get('/getVideos', FirebaseController.getVideos)
router.get('/getSponsors', FirebaseController.getSponsors)
router.post('/updatePrices', FirebaseController.updatePrices)
router.post('/migrateEventId', FirebaseController.migrateEventId)
router.post('/saveSessionAssignments', FirebaseController.saveSessionAssignments)
router.get('/getSessionAssignments/:eventId', FirebaseController.getSessionAssignments)

router.post('/register', registerLimiter, RegisterController.postRegistrant)
router.post('/signed-url-images', signedUrlLimiter, RegisterController.getUploadUrl)
router.post('/initiateMultipartUpload', initUploadLimiter, multipartUploadValidation, RegisterController.initiateMultipartUpload);
router.post('/getPartUploadUrl', partUploadLimiter, partUploadValidation, RegisterController.getPartUploadUrl);
router.post('/completeMultipartUpload', completeUploadLimiter, completeUploadValidation, RegisterController.completeMultipartUpload);
router.post('/abortMultipartUpload', abortUploadValidation, RegisterController.abortMultipartUpload);
router.post('/download-files-aws', RegisterController.downloadFilesAws)
router.post('/download-all-files-aws', RegisterController.downloadAllFiles)
router.post('/getPublicVideoLinkAws', RegisterController.getPublicVideoLinkAws)

router.post('/createJury', JuryController.createJury)
router.post('/sendEmailJuryAccountCreation', EmailController.sendEmailJuryAccountCreation)

router.get('/verifyTicker', TicketController.verifyTicket)
router.post('/saveSeatBookProfileInfo', TicketController.saveSeatBookProfileInfo)
// Verifies the token when the user first lands on the page
router.post('/verify-seat-token', TicketController.verifySeatSelectionToken);
// Saves the user's final seat selection
router.post('/confirm-seats', TicketController.confirmSeatSelection);

// --- Public Ticket Booking (self-service, Paper.id integrated) ---
router.get('/public-ticket/event-data',       PublicTicketController.getPublicTicketEventData);
router.get('/public-ticket/seats',            PublicTicketController.getPublicTicketSeats);
router.get('/public-ticket/eligible-winners', PublicTicketController.getEligibleWinners);
router.get('/public-ticket/booking-status/:bookingId', PublicTicketController.getBookingStatus);
router.post('/public-ticket/booking',         PublicTicketController.createPublicTicketBooking);
router.post('/public-ticket/webhook',         PublicTicketController.handlePublicTicketWebhook);

// --- System Settings ---
router.get('/systemSettings/global', SystemSettingsController.getGlobalSettings);
router.post('/systemSettings/global', SystemSettingsController.updateGlobalSettings);

module.exports = router;