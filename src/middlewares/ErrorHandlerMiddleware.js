class AppError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}

const errorHandler = (err, req, res, next) => {
    err.statusCode = err.statusCode || 500;
    err.status = err.status || 'error';

    if (process.env.NODE_ENV === 'development') {
        res.status(err.statusCode).json({
            success: false,
            error: err,
            message: err.message,
            stack: err.stack
        });
    } else {
        // Production
        if (err.isOperational) {
            res.status(err.statusCode).json({
                success: false,
                message: err.message
            });
        } else {
            console.error('ERROR 💥', err);
            res.status(500).json({
                success: false,
                message: 'Something went wrong'
            });
        }
    }
};

module.exports = { AppError, errorHandler };