const fs = require('fs/promises')
const path = require('path')

function splitFileName(fileName) {
    const dirRegex = /(.*[\\\/])*([^\\\/]*)/
    const dotRegex = /(.*)(\.)([^\.]*)/
    let [dir, name, ext] = ['', '', '']
    let parsedForDir = dirRegex.exec(fileName)
    dir = parsedForDir[1] ? parsedForDir[1] : ''
    let parsedForDot = dotRegex.exec(parsedForDir[2])
    if (parsedForDot) {
        if (parsedForDot[1]) {
            name = parsedForDot[1]
            ext = `.${parsedForDot[3]}`
        } else {
            if (parsedForDot[3]) {
                name = `.${parsedForDot[3]}`
            }
        }
    } else {
        name = parsedForDir[2]
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
        if(error.code === 'ENOENT') {
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

function getTopLevelFolder(filePath) {
    let parts = path.parse(filePath)
    if (parts.dir !== '') {
        return getTopLevelFolder(parts.dir)
    } else {
        return parts.base
    }
}

function processReplacements(content, patternString, groupToReplace, func) {
    let match

    while((match = patternString.exec(content))) {
        let before = match[0]
        let replacement = func(match[groupToReplace])
        let after = ''

        for (let i = 1; i <= match.length - 1; i++) {
            if (i === groupToReplace) {
                after = `${after}${replacement}`
            } else {
                after = `${after}${match[i] ?? ''}`
            }
        }
        content = content.replace(before, after)
    }
    
    return content
}

module.exports = { splitFileName, checkPathExists, generateDirectory, getTopLevelFolder, processReplacements }