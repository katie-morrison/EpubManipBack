const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs/promises')
const multer = require('multer')
const JSZip = require('jszip')
const epubZip = require('epub-zip')
const frontend = require('./config/frontend')

const ff = require('./util/file-functions')

const app = express()
const storage = multer.diskStorage({
    destination: function(req, file, cb) {
        cb(null, './uploads')
    },
    filename: function(req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname.replaceAll(' ', '_'))
    }
})
const upload = multer({storage: storage})

async function generateEpubDirectory(ePubDir) {
    fs.mkdir(path.join(__dirname, 'output', ePubDir), error => {
        if (error) {
            console.error(error)
        }
    })
}

/**
 * Pulls the files out of an epub, manipulates them if necessary, then saves them to a folder in the uploads directory.
 * Also update fileList with the names of each file saved.
 * @function populateEpubDirectory
 * @param {String} ePubDir A string representing the name of the folder to put epub files into.
 * @param {String} fileName A string representing the name of the specific epub file to disassemble.
 * @param {Object} fileOptions An object with settings for handling specific files.
 * @returns {Promise<void>}
 */
async function populateEpubDirectory(ePubDir, fileName, fileOptions) {
    const epubPath = path.join(__dirname, 'uploads', fileName)
    const promises = []
    await fs.readFile(epubPath).then(async data => {
        const zip = new JSZip()
        await zip.loadAsync(data).then(async epub => {
            for (let prop of Object.getOwnPropertyNames(epub.files)) {
                const subFile = epub.files[prop]
                if (!subFile.dir) {
                    const fileParts = ff.splitFileName(subFile.name)
                    let [dir, finalName, ext] = [fileParts.dir, fileParts.name, fileParts.ext]
                    let fullDir = path.join(__dirname, 'output', ePubDir, dir)
                    let isChapter = false
                    let filesToWrite = []
                    let ignoreWrite = false
                    if (ext === '.xhtml') {
                        let isNavigation = false
                        for (let navTitle of fileOptions['xhtmlNav']) {
                            if (finalName === navTitle.format) {
                                isNavigation = true
                                if (!fileOptions['uniqueFileLocs']['xhtml']) {
                                    fileOptions['uniqueFileLocs']['xhtml'] = path.join(fullDir, `${finalName}${ext}`)
                                } else {
                                    ignoreWrite = true
                                }
                                let tempPath = path.join(__dirname, 'output', ePubDir, '_tempmanip_')
                                filesToWrite.push({
                                    fullDir: tempPath,
                                    fullName: `${finalName}${fileOptions['fileInds']['xhtml']}${ext}`,
                                    prepend: `<meta:EpubManip>${fileName}</meta>\n`
                                })
                                fileOptions['fileInds']['xhtml']++
                                break
                            }
                        }
                        if (!isNavigation) {
                            let isExclusion = false
                            for (let file of fileOptions['nonChapterXHTML']) {
                                if (finalName === file.fileName) {
                                    finalName = `exclusion${file.id}`
                                    isExclusion = true
                                    break
                                }
                            }
                            if (!isExclusion) {
                                for (let chapterName of fileOptions['chapterFormat']) {
                                    if (finalName.includes(chapterName.format)) {
                                        isChapter = true
                                        finalName = `${chapterName.format}${fileOptions.bodyInd}`
                                        fullDir = path.join(__dirname, 'output', ePubDir, dir)
                                        fileOptions['bodyInd']++
                                        fileOptions['renameHistory'][`${fileParts.name}${fileName}`] = finalName
                                        break
                                    }
                                }
                            }
                        }
                        if (!ignoreWrite) {
                            filesToWrite.push({fullDir: fullDir, fullName: `${finalName}${ext}`, prepend: ''})
                        }
                    } else if (ext === '.opf' || ext === '.ncx') {
                        const dotless = ext.replace('.', '')
                        if (!fileOptions['uniqueFileLocs'][dotless]) {
                            fileOptions['uniqueFileLocs'][dotless] = path.join(fullDir, `${finalName}${ext}`)
                            filesToWrite.push({fullDir: fullDir, fullName: `${finalName}${ext}`, prepend: ''})
                        }
                        let tempPath = path.join(__dirname, 'output', ePubDir, '_tempmanip_')
                        filesToWrite.push({
                            fullDir: tempPath,
                            fullName: `${finalName}${fileOptions['fileInds'][dotless]}${ext}`,
                            prepend: `<meta:EpubManip>${fileName}</meta>\n`
                        })
                        fileOptions['fileInds'][dotless]++
                    } else {
                        filesToWrite.push({fullDir: fullDir, fullName: `${finalName}${ext}`, prepend: ''})
                    }
                    for (let file of filesToWrite) {
                        if (!(await ff.checkPathExists(file.fullDir))) {
                            await ff.generateDirectory(file.fullDir)
                        }
                        if (!(await ff.checkPathExists(path.join(file.fullDir, file.fullName)))) {
                            let type
                            if (['.png', '.jpg', '.jpeg'].includes(ext)) {
                                type = 'nodebuffer'
                            } else {
                                type = 'text'
                            }
                            let prom = zip.file(subFile.name).async(type).then(async data => {
                                if (ext === '.xhtml' && isChapter) {
                                    data = processEpubFile(data, fileOptions.replacements)
                                }
                                if (type === 'text') {
                                    data = `${file.prepend}${data}`
                                }
                                await fs.writeFile(path.join(file.fullDir, file.fullName), data).catch(error => {
                                    console.error(error)
                                })
                            })
                            promises.push(prom)
                        }
                    }
                }
            }
        })
    }).catch(error => {
        console.error('Error reading file:', error)
    })
    return Promise.allSettled(promises).then(() => {
        // console.log(`Directory ${ePubDir} built!`)
    })
}

async function combineUniqueFiles(ePubDir, fileOptions) {
    const dir = path.join(__dirname, 'output', ePubDir, '_tempmanip_')
    const files = await fs.readdir(dir)
    for (let file of files) {
        const ext = ff.splitFileName(file).ext
        switch (ext) {
            case '.ncx':
                await harvestNCXData(path.join(dir, file), fileOptions)
                break
            case '.opf':
                await harvestOPFData(path.join(dir, file), fileOptions)
                break
            case '.xhtml':
                await harvestContentsData(path.join(dir, file), fileOptions)
                break
            default:
                console.error(`Unexpected file extension ${ext} encountered`)
        }
    }
}

async function harvestNCXData(filePath, fileOptions) {
    try {
        let lineArr = []
        let inNavMap = false
        let blockEnded = false
        let inNavXHTMLNode = false
        let isExclusion = false
        let exclusionName = ''
        const data = await fs.readFile(filePath, {encoding: 'utf8'})
        const lines = data.split(/\r?\n/)
        const parentRegex = /^(<meta:EpubManip>)(.*?)(<\/meta>)$/
        const parentFile = parentRegex.exec(lines[0])[2]
        for (let line of lines) {
            let ind = line.indexOf('<navMap')
            if (ind !== -1) {
                inNavMap = true
            } else {
                ind = line.indexOf('</navMap>')
                if (ind !== -1) {
                    inNavMap = false
                } else {
                    if (inNavMap) {
                        ind = line.indexOf('<navPoint')
                        if (ind !== -1) {
                            inNavXHTMLNode = false
                            isExclusion = false
                            ignoreNode = false
                            exclusionName = ''
                            const navPointIdRegex = /^(.*id=")(.*?)(".*)$/
                            const parsedForId = navPointIdRegex.exec(line)
                            line = `${parsedForId[1]}navPoint-${fileOptions['cumulativeData']['ncxInd']}${parsedForId[3]}`
                            const navPointPlayOrderRegex = /^(.*playOrder=")(.*?)(".*)$/
                            const parsedForPlayOrder = navPointPlayOrderRegex.exec(line)
                            line = `${parsedForPlayOrder[1]}${fileOptions['cumulativeData']['ncxInd']}${parsedForPlayOrder[3]}`
                            fileOptions['cumulativeData']['ncxInd']++
                        } else {
                            ind = line.indexOf('<content')
                            if (ind !== -1) {
                                const fileRegex = /^(.*src=")(.*?)(".*)$/
                                const parsedForFile = fileRegex.exec(line)
                                const fileParts = ff.splitFileName(parsedForFile[2])
                                const [name, ext] = [fileParts.name, fileParts.ext]
                                let newName = name
                                for (let navTitle of fileOptions['xhtmlNav']) {
                                    if (navTitle.format === name) {
                                        let savedName = ff.splitFileName(fileOptions['uniqueFileLocs']['xhtml']).name
                                        if (savedName === name) {
                                            ignoreNode = true
                                        } else {
                                            inNavXHTMLNode = true
                                        }
                                        break
                                    }
                                }
                                if (!inNavXHTMLNode) {
                                    for (let file of fileOptions['nonChapterXHTML']) {
                                        if (name === file.fileName) {
                                            newName = `exclusion${file.id}`
                                            isExclusion = true
                                            exclusionName = name
                                            break
                                        }
                                    }
                                    if (!isExclusion) {
                                        newName = fileOptions['renameHistory'][`${name}${parentFile}`]
                                        if(!newName) {
                                            newName = name
                                        }
                                    }
                                }
                                line = `${parsedForFile[1]}${newName}${ext}${parsedForFile[3]}`
                            } else {
                                ind = line.indexOf('</navPoint')
                                if (ind !== -1) {
                                    blockEnded = true
                                }
                            }
                        }
                        lineArr.push(line)
                        if (blockEnded) {
                            if (ignoreNode) {
                                fileOptions['cumulativeData']['ncxInd']--
                            } else if (inNavXHTMLNode) {
                                if (fileOptions['cumulativeData']['ncxContentsBlock'].length === 0) {
                                    fileOptions['cumulativeData']['ncxContentsBlock'].push(...lineArr)
                                } else {
                                    fileOptions['cumulativeData']['ncxInd']--
                                }
                            } else if (isExclusion) {
                                if (!fileOptions['cumulativeData']['ncxRecordedExclusions'][exclusionName]){
                                    fileOptions['cumulativeData']['ncxNavMap'].push(...lineArr)
                                    fileOptions['cumulativeData']['ncxRecordedExclusions'][exclusionName] = true
                                } else {
                                    fileOptions['cumulativeData']['ncxInd']--
                                }
                                
                            } else {
                                fileOptions['cumulativeData']['ncxNavMap'].push(...lineArr)
                            }
                            lineArr = []
                            blockEnded = false
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error(error)
    }
}

async function harvestOPFData(filePath, fileOptions) {
    try {
        let inManifest = false
        let inSpine = false
        const data = await fs.readFile(filePath, {encoding: 'utf8'})
        const lines = data.split(/\r?\n/)
        const parentRegex = /^(<meta:EpubManip>)(.*?)(<\/meta>)$/
        const parentFile = parentRegex.exec(lines[0])[2]
        const spineRefs = {}
        for (let line of lines) {
            let ind = line.indexOf('<manifest')
            if (ind !== -1) {
                inManifest = true
            } else {
                ind = line.indexOf('<spine')
                if (ind !== -1) {
                    inSpine = true
                } else {
                    ind = line.indexOf('</manifest>')
                    if (ind !== -1) {
                        inManifest = false
                    } else {
                        ind = line.indexOf('</spine')
                        if (ind !== -1) {
                            inSpine = false
                        } else {
                            if (inManifest) {
                                const fileRegex = /^(.*href=")(.*?)(".*)$/
                                const parsedForFile = fileRegex.exec(line)
                                const fileParts = ff.splitFileName(parsedForFile[2])
                                const [name, ext] = [fileParts.name, fileParts.ext]
                                if (ext === '.ncx') {
                                    if (!fileOptions['cumulativeData']['opfNCXLine']) {
                                        fileOptions['cumulativeData']['opfNCXLine'] = line
                                    } 
                                } else if (ext === '.xhtml') {
                                    let isExclusion = false
                                    let newName = name
                                    for (let file of fileOptions['nonChapterXHTML']) {
                                        if (file.fileName === name) {
                                            newName = `exclusion${file.id}`
                                            isExclusion = true
                                            break
                                        }
                                    }
                                    if (!isExclusion) {
                                        newName = fileOptions['renameHistory'][`${name}${parentFile}`]
                                        if(!newName) {
                                            newName = name
                                        }
                                    }
                                    line = `${parsedForFile[1]}${newName}${ext}${parsedForFile[3]}`
                                    const idRegex = /^(.*id=")(.*?)(".*)$/
                                    const parsedForId = idRegex.exec(line)
                                    spineRefs[ff.splitFileName(parsedForId[2]).name] = newName
                                    line = `${parsedForId[1]}${newName}${parsedForId[3]}`
                                    fileOptions['cumulativeData']['opfManifestChapters'].add(line)
                                } else {
                                    fileOptions['cumulativeData']['opfManifestOthers'].add(line)
                                }
                            } else if (inSpine) {
                                const idRefRegex = /^(.*idref=")(.*?)(".*)$/
                                const parsedForIdRef = idRefRegex.exec(line)
                                if (spineRefs[parsedForIdRef[2]]) {
                                    line = `${parsedForIdRef[1]}${spineRefs[parsedForIdRef[2]]}${parsedForIdRef[3]}`
                                }
                                fileOptions['cumulativeData']['opfSpineOther'].add(line)
                            }
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error(error)
    }
}

async function harvestContentsData(filePath, fileOptions) {
    try {
        let inOL = false
        let finishedFirstOL = false
        let lineArr1 = []
        let lineArr2 = []
        const data = await fs.readFile(filePath, {encoding: 'utf8'})
        const lines = data.split(/\r?\n/)
        const parentRegex = /^(<meta:EpubManip>)(.*?)(<\/meta>)$/
        const parentFile = parentRegex.exec(lines[0])[2]
        for (let line of lines) {
            let ind = line.indexOf('<ol')
            if (ind !== -1) {
                inOL = true
            } else {
                ind = line.indexOf('</ol')
                if (ind !== -1) {
                    inOL = false
                    finishedFirstOL = true
                } else {
                    if (inOL) {
                        const fileRegex = /^(.*href=")(.*?)(".*)$/
                        const parsedForFile = fileRegex.exec(line)
                        const fileParts = ff.splitFileName(parsedForFile[2])
                        const [name, ext] = [fileParts.name, fileParts.ext]
                        let newName = name
                        let isExclusion = false
                        for (let file of fileOptions['nonChapterXHTML']) {
                            if (file.fileName === name) {
                                newName = `exclusion${file.id}`
                                isExclusion = true
                                break
                            }
                        }
                        if (!isExclusion) {
                            newName = fileOptions['renameHistory'][`${name}${parentFile}`]
                            if(!newName) {
                                newName = name
                            }
                        }
                        if (!finishedFirstOL) {
                            lineArr1.push(`${parsedForFile[1]}${newName}${ext}${parsedForFile[3]}`)
                        } else {
                            lineArr2.push(`${parsedForFile[1]}${newName}${ext}${parsedForFile[3]}`)
                        }

                    }
                }
            }
        }
        for (let line of lineArr1) {
            fileOptions['cumulativeData']['contentsOL'].add(line)
        }
        if (fileOptions['cumulativeData']['contentsOL2'].size === 0) {
            for (let line of lineArr2) {
                fileOptions['cumulativeData']['contentsOL2'].add(line)
            }
        }       
    } catch (error) {
        console.error(error)
    }
}

//TODO
function attemptRename(fileName, parentFileName, fileOptions) {
    let newName = fileOptions['renameHistory'][`${fileName}${parentFileName}`]
    newName = newName || fileName
    return newName
}

async function transplantCombinedFileData(fileOptions) {
    await transplantOPFData(fileOptions)
    await transplantNCXData(fileOptions)
    await transplantContentsData(fileOptions)
}

async function transplantOPFData(fileOptions) {
    try {
        const lineArr = []
        let inManifest = false
        let inSpine = false
        const data = await fs.readFile(fileOptions['uniqueFileLocs']['opf'], {encoding: 'utf8'})
        const lines = data.split(/\r?\n/)
        for (let line of lines) {
            let ind = line.indexOf('<manifest')
            if (ind !== -1) {
                inManifest = true
                lineArr.push(line)
                lineArr.push(fileOptions['cumulativeData']['opfNCXLine'])
                lineArr.push(...fileOptions['cumulativeData']['opfManifestChapters'])
                lineArr.push(...fileOptions['cumulativeData']['opfManifestOthers'])
            } else {
                ind = line.indexOf('<spine')
                if (ind !== -1) {
                    inSpine = true
                    lineArr.push(line)
                    lineArr.push(...fileOptions['cumulativeData']['opfSpineOther'])
                } else {
                    ind = line.indexOf('</manifest')
                    if (ind !== -1) {
                        inManifest = false
                    }
                    ind = line.indexOf('</spine')
                    if (ind !== -1) {
                        inSpine = false
                    }
                    if (!inManifest && !inSpine) {
                        lineArr.push(line)
                    }
                }
            }
        }
        await fs.writeFile(fileOptions['uniqueFileLocs']['opf'], lineArr.join('\n'))
    } catch (error) {
        console.error(error)
    }
}

async function transplantNCXData(fileOptions) {
    try {
        const lineArr = []
        let inNavMap = false
        const data = await fs.readFile(fileOptions['uniqueFileLocs']['ncx'], {encoding: 'utf8'})
        const lines = data.split(/\r?\n/)
        for (let line of lines) {
            let ind = line.indexOf('<navMap')
            if (ind !== -1) {
                inNavMap = true
                lineArr.push(line)
                lineArr.push(...fileOptions['cumulativeData']['ncxNavMap'])
            } else {
                ind = line.indexOf('</navMap')
                if (ind !== -1) {
                    inNavMap = false
                }
                if (!inNavMap) {
                    lineArr.push(line)
                }
            }
        }
        await fs.writeFile(fileOptions['uniqueFileLocs']['ncx'], lineArr.join('\n'))
    } catch (error) {
        console.error(error)
    }
}

async function transplantContentsData(fileOptions) {
    try {
        const lineArr = []
        let inOL = false
        let finishedFirstOL = false
        const data = await fs.readFile(fileOptions['uniqueFileLocs']['xhtml'], {encoding: 'utf8'})
        const lines = data.split(/\r?\n/)
        for (let line of lines) {
            let ind = line.indexOf('<ol')
            if (ind !== -1) {
                inOL = true
                lineArr.push(line)
                if (!finishedFirstOL) {
                    lineArr.push(...fileOptions['cumulativeData']['contentsOL'])
                } else {
                    lineArr.push(...fileOptions['cumulativeData']['contentsOL2'])
                }
            } else {
                ind = line.indexOf('</ol')
                if (ind !== -1) {
                    inOL = false
                    finishedFirstOL = true
                }
                if (!inOL) {
                    lineArr.push(line)
                }
            }
        }
        await fs.writeFile(fileOptions['uniqueFileLocs']['xhtml'], lineArr.join('\n'))
    } catch (error) {
        console.error(error)
    }
}

/**
 * Takes the files in a folder in output, zips them into a epub in the finished directory.
 * @function generateEpub
 * @param {String} ePubDir A string representing the folder in the output directory to zip into an epub, and the name said epub will be given in the finished directory.
 * @returns {Promise<void>}
 */
async function generateEpub(ePubDir) {
    try {
        const epubBuffer = await epubZip(path.join(__dirname, 'output', ePubDir))
        fs.writeFile(path.join(__dirname, 'finished', ePubDir), epubBuffer).catch(error => {
            console.error(error)
        })
    } catch (error_1) {
        console.error(error_1)
    }  
    console.log(`Epub ${ePubDir} generated`) 
}

/**
 * Takes the contents of a .xhtml file and performs any desired replacments in the body.
 * @function processEpubFile
 * @param {String} data A string representing the contents of a .xhtml file.
 * @param {Array<Object>} replacements An array of objects containing a before string to replace, and an after string to replace it with.
 * @returns {String} A string representing the updated file contents
 */
function processEpubFile(data, replacements) {
    if (replacements.length === 0) {
        return data
    }
    const processed = []
    let inBody = false
    const lines = data.split(/\r?\n/)

    for (let line of lines) {
        let ind = line.indexOf('<body')
        if (ind !== -1) {
            processed.push(line)
            inBody = true
        } else {
            ind = line.indexOf('</body')
            if (ind !== -1) {
                processed.push(line)
                inBody = false
            } else {
                if (inBody) {
                    for (let replacement of replacements) {
                        line = line.replaceAll(replacement.before, replacement.after)
                    }
                    processed.push(line)
                } else {
                    processed.push(line)
                }
            }
        }
    }
    return processed.join('\n')
}

/**
 * Removes duplicates from various fields in fileOptions possibly sent by the frontend.
 * @function cleanFileOptions
 * @param {Object} fileOptions An object with settings for handling specific files.
 */
function cleanFileOptions(fileOptions) {
    fileOptions.chapterFormat = [...new Set(fileOptions.chapterFormat)]
    const nonChapters = []
    fileOptions.nonChapterXHTML = fileOptions.nonChapterXHTML.filter(e => {
        if (nonChapters.includes(e.format)) {
            return false
        } else {
            nonChapters.push(e.format)
            return true
        }
    })
}

/**
 * Deletes files and directories used in the process of creating the final epub.
 * @function cleanUploads
 * @param {Array<String>} names An array of strings representing the names of files to be removed from the uploads directory.
 * @returns {Promise<void>}
 */
async function cleanUploads(names) {
    for (let name of names) {
        const filePath = path.join(__dirname, 'uploads', name)
        try {
            fs.rm(filePath).then(() => {
                console.log(`File ${name} deleted successfully`)
            }).catch(error => {
                console.error(error)
            })
        } catch (error) {
            console.error(`Error deleting file: ${name}`)
        }
    }
    
}

/**
 * Deletes files and directories used in the process of creating the final epub.
 * @function cleanOutput
 * @param {String} ePubDir A string representing the folder in output to be deleted.
 * @returns {Promise<void>}
 */
async function cleanOutput(ePubDir) {
    const filePath = path.join(__dirname, 'output', ePubDir)
    try {
        fs.rm(filePath, {recursive: true, force: true}).then(() => {
            console.log(`Directory ${filePath} deleted successfully`)
        }).catch(error => {
            console.error(error)
        })     
    } catch (error) {
        console.error(`Error deleting directory: ${filePath}`)
    }
}

/**
 * Deletes the created epub once it has been sent back to the frontend
 * @function cleanFinished
 * @param {String} ePubDir A string representing he name of the epub to be deleted.
 * @returns {Promise<void>}
 */
async function cleanFinished(ePubDir) {
    const filePath = path.join(__dirname, 'finished', ePubDir)
    try {
        fs.rm(filePath).then(() => {
            console.log(`File ${ePubDir} deleted successfully`)
        }).catch(error => {
            console.error(error)
        })     
    } catch (error) {
        console.error(`Error deleting file: ${ePubDir}`)
    }
}

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

async function removeTempManip(ePubDir) {
    try {
        await fs.rm(path.join(__dirname, 'output', ePubDir, '_tempmanip_'), {recursive: true, force: true})
    } catch (error) {
        console.error(`Error deleting _tempmanip_ folder in ${ePubDir}`)
    }
    

}

async function startServer() {
    await cleanTempFolders()
    const PORT = 3001
    app.listen(PORT, () => {
        console.log(`Server running on PORT ${PORT}`)
    })
}

app.use(cors({
    origin: frontend
}))

app.post('/uploads', upload.array('myFiles', 100), async (request, response) => {
    if (request.files && request.files.length > 0) {
        const files = request.files.filter(file => {
            return ff.splitFileName(file.filename).ext === '.epub'
        })
        if (files.length > 0) {
            const fileOptions = JSON.parse(request.body['fileOptions'])
            cleanFileOptions(fileOptions)
            fileOptions['bodyInd'] = 0
            fileOptions['fileInds'] = {'xhtml': 0, 'opf': 0, 'ncx': 0}
            fileOptions['renameHistory'] = {}
            fileOptions['cumulativeData'] = {
                'ncxInd': 1,
                'ncxContentsBlock': [],
                'ncxNavMap': [],
                'ncxRecordedExclusions': fileOptions['nonChapterXHTML'].reduce((obj, exclusion) => {
                    obj[exclusion['fileName']] = false
                    return obj
                }, {}),
                'opfNCXLine': '',
                'opfContentsLine': '',
                'opfManifestChapters': new Set(),
                'opfManifestOthers': new Set(),
                'opfSpineContents': '',
                'opfSpineOther': new Set(),
                'contentsOL': new Set(),
                'contentsOL2': new Set()
            }
            fileOptions['uniqueFileLocs'] = {'opf': '', 'ncx': '', 'xhtml': ''}
            const ePubDir = files[0].filename
            const names = []
            const fileList = []
            await generateEpubDirectory(ePubDir)
            for (let file of files) {
                names.push(file.filename)
                await populateEpubDirectory(ePubDir, file.filename, fileOptions)
            }

            await combineUniqueFiles(ePubDir, fileOptions)
            await transplantCombinedFileData(fileOptions)
            await removeTempManip(ePubDir)
            await generateEpub(ePubDir)
            cleanUploads(names)
            cleanOutput(ePubDir)
            response.send(ePubDir)
        } else {
            response.status(400).send('No files uploaded. None of the received files were of type epub')
        }

    } else {
        response.status(400).send('No files uploaded')
    }
})

app.get('/getEpub/:id', (request, response) => {
    const filePath = path.join(__dirname, 'finished', request.params.id)
    response.sendFile(filePath, error => {
        if (error) {
            console.error(`Error sending file: ${error}`)
            response.status(500).send('Error sending file')
        } else {
            cleanFinished(request.params.id)
        }
    })
})

app.get('/getDemoEpubs', (request, response) => {
    const filePath = path.join(__dirname, 'demo', 'Demo_Epubs.zip')
    response.sendFile(filePath, error => {
        if (error) {
            console.error('Error sending demo files')
            response.status(500).send('Error sending demo files')
        }
    })
})

app.post('/calculateDiagnostics', upload.array('myFile', 1), async (request, response) => {
    if (request.files && request.files.length > 0) {
        const files = request.files.filter(file => {
            return ff.splitFileName(file.filename).ext ==='.epub'
        })
        if (files.length > 0) {
            const fileNames = []
            const epubPath = path.join(__dirname, 'uploads', files[0].filename)
            await fs.readFile(epubPath).then(async data => {
                const zip = new JSZip()
                await zip.loadAsync(data).then(async epub => {
                    for (let prop of Object.getOwnPropertyNames(epub.files)) {
                        const file = epub.files[prop]
                        if (!file.dir) {
                            fileNames.push(file.name)
                        }
                    }
                })
            }).then(() => {
                cleanUploads([files[0].filename])
                response.send(fileNames)
            }).catch(error => {
                console.error('Error reading file:', error)
            })

        } else {
            response.status(400).send('No files uploaded. None of the received files were of type epub')
        }
    } else {
        response.status(400).send('No files uploaded')
    }
})

app.get('/', (request, response) => {
    response.send(`Hello world, were expecting stuff from ${frontend}`)
})

startServer()