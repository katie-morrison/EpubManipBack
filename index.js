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
                                let finalContents = false
                                if (!fileOptions['uniqueFileLocs']['xhtml']) {
                                    fileOptions['uniqueFileLocs']['xhtml'] = path.join(fullDir, `${finalName}${ext}`)
                                    finalContents = true
                                } else {
                                    ignoreWrite = true
                                }
                                let tempPath = path.join(__dirname, 'output', ePubDir, '_tempmanip_')
                                filesToWrite.push({
                                    fullDir: tempPath,
                                    fullName: `${finalName}${fileOptions['fileInds']['xhtml']}${ext}`,
                                    prepend: `<meta:EpubManip copyOfFinal="${finalContents}">${fileName}</meta>\n`
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
    //TODO: ensure opfNCXLine fallback and opfContentsLine id are the same value
}

async function harvestNCXData(filePath, fileOptions) {
    try {
        const data = await fs.readFile(filePath, {encoding: 'utf8'})
        let remaining = ''
        const parentRegex = /^(<meta:EpubManip>)(.*?)(<\/meta>.*)/s
        const parentFile = parentRegex.exec(data)[2]
        const navPointRegex = /(.*?)(<navPoint.*?<\/navPoint>)(.*)/s
        const navPointIdRegex = /(.*id=")(.*?)(".*)/s
        const navPointPlayOrderRegex = /(.*playOrder=")(.*?)(".*)/s
        const navPointSrcRegex = /(.*src=")(.*?)(\..*)/s
        let parsedForNavPoint = navPointRegex.exec(data)
        while (parsedForNavPoint) {
            let inNavXHTMLNode = false
            let isExclusion = false
            let ignoreWrite = false
            let exclusionName = ''
            remaining = parsedForNavPoint[3]
            let navPoint = parsedForNavPoint[2]
            let parsedForId = navPointIdRegex.exec(navPoint)
            navPoint = `${parsedForId[1]}navPoint-${fileOptions['cumulativeData']['ncxInd']}${parsedForId[3]}`
            let parsedForPlayOrder = navPointPlayOrderRegex.exec(navPoint)
            navPoint = `${parsedForPlayOrder[1]}${fileOptions['cumulativeData']['ncxInd']}${parsedForPlayOrder[3]}`
            let parsedForSrc = navPointSrcRegex.exec(navPoint)
            if (parsedForSrc) {
                let name = parsedForSrc[2]
                let newName = name
                for (let navTitle of fileOptions['xhtmlNav']) {
                    if (navTitle.format === name) {
                        let savedName = ff.splitFileName(fileOptions['uniqueFileLocs']['xhtml']).name
                        inNavXHTMLNode = true
                        if (savedName !== name) {
                            ignoreWrite = true
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
                navPoint = `${parsedForSrc[1]}${newName}${parsedForSrc[3]}`
            }
            if (!ignoreWrite) {
                if (inNavXHTMLNode) {
                    if (fileOptions['cumulativeData']['ncxContentsBlock'].length === 0) {
                        fileOptions['cumulativeData']['ncxContentsBlock'].push(navPoint)
                        fileOptions['cumulativeData']['ncxInd']++
                    }
                } else if (isExclusion) {
                    if (!fileOptions['cumulativeData']['ncxRecordedExclusions'][exclusionName]){
                        fileOptions['cumulativeData']['ncxNavMap'].push(navPoint)
                        fileOptions['cumulativeData']['ncxRecordedExclusions'][exclusionName] = true
                        fileOptions['cumulativeData']['ncxInd']++
                    }
                } else {
                    fileOptions['cumulativeData']['ncxNavMap'].push(navPoint)
                    fileOptions['cumulativeData']['ncxInd']++
                }
            }
            parsedForNavPoint = navPointRegex.exec(remaining)
        }
    } catch (error) {
        console.error(error)
    }
}

async function harvestOPFData(filePath, fileOptions) {
    try {
        const data = await fs.readFile(filePath, {encoding: 'utf8'})
        let remaining = ''
        const spineRefs = {}
        const parentRegex = /^(<meta:EpubManip>)(.*?)(<\/meta>.*)/s
        const parentFile = parentRegex.exec(data)[2]
        const itemRegex = /(.*?)(<item .*?\/>)(.*)/s
        const itemHrefRegex = /(.*href=")(.*?)(".*)/s
        const itemIdRegex = /(.*id=")(.*?)(".*)/s
        const itemRefRegex = /(.*?)(<itemref.*?\/>)(.*)/s
        const itemRefIdRefRegex = /(.*idref=")(.*?)(".*)/s
        let parsedForItem = itemRegex.exec(data)
        while (parsedForItem) {
            let inNavXHTMLNode = false
            let isExclusion = false
            let isNcxNode = false
            let ignoreWrite = false
            let isOther = false
            let newName = ''
            let exclusionName = ''
            remaining = parsedForItem[3]
            let item = parsedForItem[2]
            let parsedForHref = itemHrefRegex.exec(item)
            const fileParts = ff.splitFileName(parsedForHref[2])
            let [dir, name, ext] = [fileParts.dir, fileParts.name, fileParts.ext]
            if (ext === '.ncx') {
                isNcxNode = true
                if (fileOptions['cumulativeData']['opfNCXLine']) {
                    ignoreWrite = true
                }
            } else if (ext === '.xhtml') {
                for (let navTitle of fileOptions['xhtmlNav']) {
                    if (navTitle.format === name) {
                        let savedName = ff.splitFileName(fileOptions['uniqueFileLocs']['xhtml']).name
                        inNavXHTMLNode = true
                        if (savedName !== name) {
                            ignoreWrite = true
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
                    }
                }
            } else {
                isOther = true
            }
            item = `${parsedForHref[1]}${dir}${newName || name}${ext}${parsedForHref[3]}`
            let parsedforId = itemIdRegex.exec(item)
            const originalID = parsedforId[2]
            const newID = newName || name
            item = `${parsedforId[1]}${newID}${parsedforId[3]}`
            if (!ignoreWrite) {
                if (isNcxNode) {
                    if (!fileOptions['cumulativeData']['opfNCXLine']) {
                        fileOptions['cumulativeData']['opfNCXLine'] = item
                    }
                } else if (inNavXHTMLNode) {
                    if (!fileOptions['cumulativeData']['opfContentsLine']) {
                        fileOptions['cumulativeData']['opfContentsLine'] = item
                        spineRefs[originalID] = newID
                    }
                } else if (isExclusion) {
                    if (!fileOptions['cumulativeData']['opfRecordedExclusions'][exclusionName]) {
                        fileOptions['cumulativeData']['opfManifestData'].push(item)
                        fileOptions['cumulativeData']['opfRecordedExclusions'][exclusionName] = true
                        spineRefs[originalID] = newID
                    }
                } else {
                    if (isOther) {
                        if (!fileOptions['cumulativeData']['opfRecordedOthers'][`${name}${ext}`]) {
                            fileOptions['cumulativeData']['opfManifestData'].push(item)
                            fileOptions['cumulativeData']['opfRecordedOthers'][`${name}${ext}`] = true
                        }
                    } else {
                        fileOptions['cumulativeData']['opfManifestData'].push(item)
                        spineRefs[originalID] = newID
                    }
                }
            }
            parsedForItem = itemRegex.exec(remaining)
        }
        console.log('Spinerefs: ', spineRefs)
        let parsedForItemRef = itemRefRegex.exec(remaining)
        while (parsedForItemRef) {
            remaining = parsedForItemRef[3]
            let item = parsedForItemRef[2]
            console.log(item)
            let parsedForItemRefIdRef= itemRefIdRefRegex.exec(item)
            let name = parsedForItemRefIdRef[2]
            if (spineRefs[name]) {
                fileOptions['cumulativeData']['opfSpineOther'].push(`${parsedForItemRefIdRef[1]}${spineRefs[name]}${parsedForItemRefIdRef[3]}`)
            }
            parsedForItemRef = itemRefRegex.exec(remaining)
        }
    } catch (error) {
        console.error(error)
    }
}

async function harvestContentsData(filePath, fileOptions) {
    try {
        const data = await fs.readFile(filePath, {encoding: 'utf8'})
        let remaining = ''
        const parentRegex = /^(<meta:EpubManip copyOfFinal=")(.*?)(">)(.*?)(<\/meta>.*)/s
        const copyOfFinal = JSON.parse(parentRegex.exec(data)[2])
        const parentFile = parentRegex.exec(data)[4]
        const olRegex = /(.*?)(<ol>.*?<\/ol>)(.*)/s
        const liRegex = /(.*?)(<li>.*?<\/li>)(.*)/s
        const liHrefRegex = /(.*href=")(.*?)(\..*)/s
        let parsedForOl = olRegex.exec(data)
        const ol1 = parsedForOl[2]
        let parsedForLi = liRegex.exec(ol1)
        while (parsedForLi) {
            let inNavXHTMLNode = false
            let ignoreWrite = false
            let isExclusion = false
            let exclusionName = ''
            let newName = ''
            let item = parsedForLi[2]
            remaining = parsedForLi[3]
            let parsedForLiHref = liHrefRegex.exec(item)
            let name = parsedForLiHref[2]
            for (let navTitle of fileOptions['xhtmlNav']) {
                if (navTitle.format === name) {
                    let savedName = ff.splitFileName(fileOptions['uniqueFileLocs']['xhtml']).name
                    inNavXHTMLNode = true
                    if (savedName !== name) {
                        ignoreWrite = true
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
                }
            }
            item = `${parsedForLiHref[1]}${newName || name}${parsedForLiHref[3]}`
            if (!ignoreWrite) {
                if (isExclusion) {
                    if (!fileOptions['cumulativeData']['contentsRecordedExclusions'][exclusionName]) {
                        fileOptions['cumulativeData']['contentsOL1'].push(item)
                        fileOptions['cumulativeData']['contentsRecordedExclusions'][exclusionName] = true
                    }
                } else {
                    fileOptions['cumulativeData']['contentsOL1'].push(item)
                }
            }
            parsedForLi = liRegex.exec(remaining)
        }
        if (copyOfFinal) {
            parsedForOl = olRegex.exec(parsedForOl[3])
            const ol2 = parsedForOl[2]
            let parsedForLi = liRegex.exec(ol2)
            while (parsedForLi) {
                let item = parsedForLi[2]
                remaining = parsedForLi[3]
                let parsedForLiHref = liHrefRegex.exec(item)
                if (parsedForLiHref) {
                    let name = parsedForLiHref[2]
                    let savedName = ff.splitFileName(fileOptions['uniqueFileLocs']['xhtml']).name
                    if (name === savedName) {
                        fileOptions['cumulativeData']['contentsOL2'].push(item)
                    } else {
                        let newName = fileOptions['renameHistory'][`${name}${parentFile}`]
                        item = `${parsedForLiHref[1]}${newName || name}${parsedForLiHref[3]}`
                        fileOptions['cumulativeData']['contentsOL2'].push(item)
                    }
                } else {
                    fileOptions['cumulativeData']['contentsOL2'].push(item)
                }
                parsedForLi = liRegex.exec(remaining)
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
    if (fileOptions['uniqueFileLocs']['ncx']) {
        await transplantNCXData(fileOptions)
    }
    if (fileOptions['uniqueFileLocs']['xhtml']) {
        await transplantContentsData(fileOptions)
    }
}

async function transplantOPFData(fileOptions) {
    try {
        let data = await fs.readFile(fileOptions['uniqueFileLocs']['opf'], {encoding: 'utf8'})
        const manifestRegex = /(.*?<manifest>\s*)(.*?)(\s*<\/manifest>.*)/s
        const spineRegex = /(.*?<spine.*?>\s*)(.*?)(\s*<\/spine>.*)/s
        const parsedForManifest = manifestRegex.exec(data)
        const manifestData = [
            fileOptions['cumulativeData']['opfNCXLine'],
            fileOptions['cumulativeData']['opfContentsLine'],
            ...fileOptions['cumulativeData']['opfManifestData']
        ].join('\n')
        const parsedForSpine = spineRegex.exec(parsedForManifest[3])
        const spineData = fileOptions['cumulativeData']['opfSpineOther'].join('\n')

        data = `${parsedForManifest[1]}${manifestData}${parsedForSpine[1]}${spineData}${parsedForSpine[3]}`
        await fs.writeFile(fileOptions['uniqueFileLocs']['opf'], data)
    } catch (error) {
        console.error(error)
    }
}

async function transplantNCXData(fileOptions) {
    try {
        let data = await fs.readFile(fileOptions['uniqueFileLocs']['ncx'], {encoding: 'utf8'})
        const navMapRegex = /(.*?<navMap>\s*)(.*?)(\s*<\/navMap>.*)/s
        const parsedForNavMap = navMapRegex.exec(data)
        const navMapData = [
            ...fileOptions['cumulativeData']['ncxContentsBlock'],
            ...fileOptions['cumulativeData']['ncxNavMap']
        ].join('\n')
        data = `${parsedForNavMap[1]}${navMapData}${parsedForNavMap[3]}`
        await fs.writeFile(fileOptions['uniqueFileLocs']['ncx'], data)
    } catch (error) {
        console.error(error)
    }
}

async function transplantContentsData(fileOptions) {
    try {
        let data = await fs.readFile(fileOptions['uniqueFileLocs']['xhtml'], {encoding: 'utf8'})
        const olRegex = /(.*?<ol>\s*)(.*?)(\s*<\/ol>.*)/s
        const parsedForFirstOL = olRegex.exec(data)
        const ol1Data = fileOptions['cumulativeData']['contentsOL1'].join('\n')
        const parsedForSecondOL = olRegex.exec(parsedForFirstOL[3])
        const ol2Data = fileOptions['cumulativeData']['contentsOL2'].join('\n')
        data = `${parsedForFirstOL[1]}${ol1Data}${parsedForSecondOL[1]}${ol2Data}${parsedForSecondOL[3]}`
        await fs.writeFile(fileOptions['uniqueFileLocs']['xhtml'], data)
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

    const bodyRegex = /(.*?<body>\s*)(.*?)(\s*<\/body>.*)/s
    const parsedForBody = bodyRegex.exec(data)
    let processed = parsedForBody[2]
    for (let replacement of replacements) {
        processed = processed.replaceAll(replacement.before, replacement.after)
    }
    return `${parsedForBody[1]}${processed}${parsedForBody[3]}`
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
                'ncxRecordedExclusions': {},
                'opfNCXLine': '',
                'opfContentsLine': '',
                'opfRecordedExclusions': {},
                'opfRecordedOthers': {},
                'opfManifestData': [],
                'opfSpineContents': '',
                'opfSpineOther': [],
                'opfSpineOtherExistingIds': {},
                'contentsRecordedExclusions': {},
                'contentsOL1': [],
                'contentsOL2': []
            }
            fileOptions['uniqueFileLocs'] = {'opf': '', 'ncx': '', 'xhtml': ''}
            const ePubDir = files[0].filename
            const names = []
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