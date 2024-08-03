function executeDatabaseOperation(dbFunction, ...args) {
    return new Promise((resolve, reject) => {
        dbFunction(...args, (error, result) => {
            if (error) {
                reject(error);
            } else {
                resolve(result);
            }
        });
    });
}


module.exports = {
    executeDatabaseOperation,
}