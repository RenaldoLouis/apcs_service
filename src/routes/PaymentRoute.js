const express = require('express')
const router = express.Router();
const paymentController = require("../controllers/PaymentController");
const EmailController = require("../controllers/EmailController");
const FirebaseController = require("../controllers/FirebaseController");
const RegisterController = require("../controllers/RegisterController");
const BookingController = require("../controllers/BookingController");
const TicketController = require("../controllers/TicketController");
const { paymentValidation } = require('../utils/ValidationUtil');
const { multipartUploadValidation, partUploadValidation, completeUploadValidation } = require('../middlewares/ValidationMiddleware');

router.post('/createPayment', paymentValidation, paymentController.createPayment)

router.post('/sendEmail', EmailController.sendEmail)
router.post('/sendEmailFail', EmailController.sendEmailFail)
router.post('/sendEmailWinner', EmailController.sendEmailWinner)
router.post('/sendEmailSessionWinner', EmailController.sendEmailSessionWinner)
router.post('/sendEmailPaymentRequest', EmailController.sendEmailPaymentRequest)
router.post('/sendSeatBookingEmail', EmailController.sendSeatBookingEmail)
router.post('/sendGeneralSeatingEmail', EmailController.sendGeneralSeatingEmail);
router.post('/sendTeamEntryPassEmail', EmailController.sendTeamEntryPassEmail);
router.post('/sendSponsorEntryPassEmail', EmailController.sendSponsorEntryPassEmail);
router.post('/sendEmailNotifyApcs', EmailController.sendEmailNotifyApcs)
router.post('/sendEmailNotifyBulkUpdateRegistrant', EmailController.sendEmailNotifyBulkUpdateRegistrant)

router.get('/getGaleries', FirebaseController.getGaleries)
router.get('/getVideos', FirebaseController.getVideos)
router.get('/getSponsors', FirebaseController.getSponsors)

router.post('/register', RegisterController.postRegistrant)
router.post('/signed-url-images', RegisterController.getUploadUrl)
router.post('/initiateMultipartUpload', multipartUploadValidation, RegisterController.initiateMultipartUpload);
router.post('/getPartUploadUrl', partUploadValidation, RegisterController.getPartUploadUrl);
router.post('/completeMultipartUpload', completeUploadValidation, RegisterController.completeMultipartUpload);
router.post('/download-files-aws', RegisterController.downloadFilesAws)
router.post('/download-all-files-aws', RegisterController.downloadAllFiles)
router.post('/getPublicVideoLinkAws', RegisterController.getPublicVideoLinkAws)

router.get('/verifyTicker', TicketController.verifyTicket)
router.post('/saveSeatBookProfileInfo', TicketController.saveSeatBookProfileInfo)
// Verifies the token when the user first lands on the page
router.post('/verify-seat-token', TicketController.verifySeatSelectionToken);
// Saves the user's final seat selection
router.post('/confirm-seats', TicketController.confirmSeatSelection);

module.exports = router;