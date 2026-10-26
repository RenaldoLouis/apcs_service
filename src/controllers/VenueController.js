const repository = require('../repositories/VenueRepository');
const VenueSeatMapService = require('../services/VenueSeatMapService');
async function updateMetadata(req, res, next) {
    try {
        const result = await repository.updateMetadata(req.params.eventId, req.params.venueId, req.body);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
}
async function updateLayout(req, res, next) {
    try {
        const result = await repository.updateLayout(req.params.eventId, req.params.venueId, req.body);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
}
/** GET /api/v1/apcs/venue-settings/:eventId/:venueId/seat-map */
async function getSeatMap(req, res, next) {
    try {
        const result = await VenueSeatMapService.getVenueSeatMap(req.params);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
}
module.exports = { updateMetadata, updateLayout, getSeatMap };
