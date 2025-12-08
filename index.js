const express = require('express')
const app = express()
const bodyParser = require('body-parser')
const { errorHandler } = require("./src/middlewares/ErrorHandlerMiddleware.js") // ✅ Destructure to get errorHandler
var cors = require('cors')
const port = 8080
const paymentRoute = require('./src/routes/PaymentRoute.js')
const PaymentIntegrationRoute = require('./src/routes/PaymentIntegrationRoute.js')
const wasteRoute = require('./src/routes/WasteRoutes.js')

app.use(cors())
app.use(bodyParser.json())
app.use(
    bodyParser.urlencoded({
        extended: true,
    })
)

app.use('/api/v1/apcs', paymentRoute)
app.use('/api/v1/apcs/paymentIntegration', PaymentIntegrationRoute)
// app.use('/api/v1/apcs', wasteRoute)

app.use(errorHandler)

app.listen(port, () => {
    console.log(`App running on port ${port}.`)
})