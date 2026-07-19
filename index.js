const express = require('express')
const app = express()
const bodyParser = require('body-parser')
const rateLimit = require('express-rate-limit')
const { errorHandler } = require("./src/middlewares/ErrorHandlerMiddleware.js") // ✅ Destructure to get errorHandler
var cors = require('cors')
const port = 8080
const paymentRoute = require('./src/routes/PaymentRoute.js')
const paperRoute = require('./src/routes/PaperRoute.js')
const PaymentIntegrationRoute = require('./src/routes/PaymentIntegrationRoute.js')
const wasteRoute = require('./src/routes/WasteRoutes.js')
const { startPublicTicketSweeper } = require('./src/jobs/PublicTicketSweeper.js')

app.use(cors())
app.set('trust proxy', 1) // Required for express-rate-limit when behind reverse proxies (like cPanel)
app.use(bodyParser.json({ limit: '1mb' }))

// Global rate limiter
const globalLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // Limit each IP to 100 requests per `window` (here, per 1 minute)
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: { error: 'Too many requests, please try again later.' }
})
app.use(globalLimiter)

app.use(
    bodyParser.urlencoded({
        extended: true,
    })
)

app.use('/api/v1/apcs', paymentRoute)
app.use('/api/v1/apcs/payment', paperRoute)

//TODO:might delete this after paper integration
app.use('/api/v1/apcs/paymentIntegration', PaymentIntegrationRoute)
// app.use('/api/v1/apcs', wasteRoute)

app.use(errorHandler)

// Start background jobs
startPublicTicketSweeper()

app.listen(port, () => {
    console.log(`App running on port ${port}.`)
})