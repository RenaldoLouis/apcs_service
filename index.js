const express = require('express')
const app = express()
const bodyParser = require('body-parser')
const { errorHandler } = require("./src/middlewares/ErrorHandlerMiddleware.js") // ✅ Destructure to get errorHandler
var cors = require('cors')
const port = 8080
const paymentRoute = require('./src/routes/PaymentRoute.js')
const paperRoute = require('./src/routes/PaperRoute.js')
const PaymentIntegrationRoute = require('./src/routes/PaymentIntegrationRoute.js')
const wasteRoute = require('./src/routes/WasteRoutes.js')

// 1. Define the CORS options separately for clarity
const corsOptions = {
    origin: ['https://www.apcsmusic.com'],
    credentials: true, // ✅ Important: allows cookies/auth headers to be sent
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // ✅ Explicitly allow these methods
    allowedHeaders: ['Content-Type', 'Authorization', 'auth-token']
};

// 2. Use the CORS middleware ONLY ONCE with the options
app.use(cors(corsOptions));

// 3. Explicitly handle Preflight (OPTIONS) requests
// This ensures the browser gets the correct 'OK' before sending the real data
app.options('*', cors(corsOptions));

app.use(bodyParser.json())
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

app.listen(port, () => {
    console.log(`App running on port ${port}.`)
})