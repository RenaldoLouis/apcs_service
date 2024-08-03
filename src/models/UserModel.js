function getCreateUserResponseDTO(user) {
    return {
        message: 'Success create user',
        id: user.id,
        name: user.name,
        email: user.email,
    }
};


module.exports = {
    getCreateUserResponseDTO
}