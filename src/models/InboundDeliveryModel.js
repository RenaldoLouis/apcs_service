function InboundDeliveryDto(data) {
    return {
        id: data.id,
        createdAt: data.createdAt,
        rejectedWeight: data.rejectedWeight,
        organicWeight: data.organicWeight,
        inorganicWeight: data.inorganicWeight,
        hardOrganicWeight: data.hardOrganicWeight,
        licensePlate: data.licensePlate,
        note: data.note,
    }
};

module.exports = {
    InboundDeliveryDto
}