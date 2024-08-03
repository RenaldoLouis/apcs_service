const express = require('express')
const app = express()
const bodyParser = require('body-parser')
const ErrorHandler = require("./src/middlewares/ErrorHandlerMiddleware.js")
var cors = require('cors')
const port = 3001
const inboundRoute = require('./src/routes/InboundDeliveryRoutes.js')
const wasteRoute = require('./src/routes/WasteRoutes.js')

app.use(cors())
app.use(bodyParser.json())
app.use(
    bodyParser.urlencoded({
        extended: true,
    })
)

app.use('/api/v1/delterra', inboundRoute)
app.use('/api/v1/delterra', wasteRoute)

app.use(ErrorHandler)

app.listen(port, () => {
    console.log(`App running on port ${port}.`)
})