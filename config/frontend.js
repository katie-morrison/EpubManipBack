let frontend = []

if (process.env.FRONTEND) {
    for (address of process.env.FRONTEND.split(',')) {
        frontend.push(address)
    }
} else {
    frontend.push('http://localhost:3000')
}

module.exports = frontend
