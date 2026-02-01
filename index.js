const path = require('path')
const fs = require('fs/promises')
const app = require('./app')

async function cleanTempFolders() {
    try {
        await fs.rm(path.join(__dirname, 'uploads'), {recursive: true, force: true})
        await fs.rm(path.join(__dirname, 'output'), {recursive: true, force: true})
        await fs.rm(path.join(__dirname, 'finished'), {recursive: true, force: true})
    } catch (error) {
        console.error(`Error deleting temp directories: ${error}`)
    }
    try {
        await fs.mkdir(path.join(__dirname, 'uploads'), {recursive: true})
        await fs.mkdir(path.join(__dirname, 'output'), {recursive: true})
        await fs.mkdir(path.join(__dirname, 'finished'), {recursive: true})
    } catch (error) {
        console.error(`Error creating temp directories: ${error}`)
    }
}

async function startServer() {
    await cleanTempFolders()
    const PORT = 3001
    app.listen(PORT, () => {
        console.log(`Server running on PORT ${PORT}`)
    })
}

startServer()