let frontend

if (process.env.FRONTEND) {
    frontend = process.env.FRONTEND
} else {
    frontend = 'http://localhost:3000'
}

module.exports = frontend
