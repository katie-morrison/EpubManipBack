const fs = require('fs/promises')

function splitFileName(fileName) {
    if (fileName === '.') {
        throw new Error(`Invalid file name: ${fileName}`)
    }

    let dir, name, ext
    const splitDir = /^(.*[\\/])?(.*)?$/
    const dirMatch = splitDir.exec(fileName)
    if (dirMatch[1]) {
        dir = dirMatch[1]
    } else {
        dir = ''
    }
    if(dirMatch[2]) {
        name = dirMatch[2]
        lastDot = name.lastIndexOf('.')
        if (lastDot === -1 || lastDot === 0) {
            ext = ''
        } else {
            ext = name.slice(lastDot, name.length)
            name = name.slice(0, lastDot)
        }
    } else {
        [name, ext] = ['', '']
    }

    return {dir: dir, name: name, ext: ext}
}

/**
 * Checks if a file or directory exists at the path given.
 * @function checkPathExists
 * @param {*} path A string representing the full path to a file or directory.
 * @returns {Promise<boolean>}
 */
async function checkPathExists(path) {
    try {
        await fs.access(path)
    } catch(error) {
        if(error.code ==='ENOENT') {
            return false
        }
    }
    return true

}

async function generateDirectory(filePath) {
    await fs.mkdir(filePath, {recursive: true}).catch(error => {
        console.error(error)
    })
}

module.exports = { splitFileName, checkPathExists, generateDirectory }