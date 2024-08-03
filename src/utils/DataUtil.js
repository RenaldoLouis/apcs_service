function getOffset(currentPage = 1, listPerPage) {
    return (currentPage - 1) * [listPerPage];
}

function emptyOrRows(rows) {
    if (!rows) {
        return [];
    }
    return rows;
}

function getPaginationInfo(page, limit, count) {
    return {
        page: +page,
        limit: +limit,
        totalCount: count,
        totalPages: Math.ceil(count / limit),
    };
};

module.exports = {
    getOffset,
    emptyOrRows,
    getPaginationInfo
}
