const repository = require('../repositories/VenueRepository');
async function updateMetadata(req, res, next) {
    try {
        const result = await repository.updateMetadata(req.params.eventId, req.params.venueId, req.body);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
}
module.exports = { updateMetadata };
