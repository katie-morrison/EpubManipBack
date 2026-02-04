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
const storage = multer.memoryStorage()
const upload = multer({storage: storage})

const CONTAINER_NAME = 'EpubManipGenerated'
const EXCLUSION_RENAME = 'exclusion'
const CHAPTER_RENAME = 'chapter'
const OTHER_RENAME = 'other'

const FileType = Object.freeze({
    NAVIGATION: 'NAVIGATION',
    CHAPTER: 'CHAPTER',
    EXCLUSION: 'EXCLUSION',
    IGNORE: 'IGNORE',
    OTHER: 'OTHER'
})

async function generateSubFolders(ePubDir) {
    fs.mkdir(path.join(__dirname, 'output', ePubDir), error => {
        if (error) {
            console.error(error)
        }
    })

    fs.mkdir(path.join(__dirname, 'uploads', ePubDir), error => {
        if (error) {
            console.error(error)
        }
    })

}

/**
 * Pulls the files out of an epub, manipulates them if necessary, then saves them to a folder in the uploads directory.
 * @function populateEpubDirectory
 * @param {Object} fileOptions An object with settings for handling specific files.
 * @param {String} ePubDir A string representing the name of the folder to put epub files into.
 * @param {String} ePubName A string representing the name of the specific epub file to disassemble.
 * @returns {Promise<void>}
 */
async function populateEpubDirectory(fileOptions, ePubDir, ePubName) {
    const filePath = path.join(__dirname, 'uploads', ePubDir, ePubName)
    const writeTo = path.join(__dirname, 'output', ePubDir)
    await fs.readFile(filePath).then(async data => {
        const zip = new JSZip()
        await zip.loadAsync(data).then(async epub => {
            for (let prop of Object.getOwnPropertyNames(epub.files)) {
                const subFile = epub.files[prop]
                if (!subFile.dir) {
                    let parts = path.parse(subFile.name)
                    let [pathFromEpubRoot, fileName, ext] = [parts.dir, parts.name, parts.ext]
                    let relativePath = path.join(pathFromEpubRoot, fileName + ext)
                    let pathPrepend = CONTAINER_NAME
                    let finalPath = path.join((ff.getTopLevelFolder(subFile.name) === CONTAINER_NAME ? '' : pathPrepend), pathFromEpubRoot)
                    let type = fileOptions.getFileType(fileName)
                    if (ext === '.ncx' || ext === '.opf' || (ext === '.xhtml' && type === FileType.NAVIGATION)) {
                        let firstInstance = false
                        if (!fileOptions['uniqueFileLocs'][ext]) {
                            fileOptions['uniqueFileLocs'][ext] = path.join(pathPrepend, fileName + ext)
                            firstInstance = true
                        }
                        let tempLoc = path.join(writeTo, '_tempmanip_')
                        if (!(await ff.checkPathExists(tempLoc))) {
                            await ff.generateDirectory(tempLoc)
                        }
                        let tempInd = fileOptions['tempInds'][ext]
                        await zip.file(subFile.name).async('text').then(async data => {
                            data = `<meta:EpubManip copyOfFinal="${firstInstance}">${ePubName}</meta>\n${data}`
                            await fs.writeFile(path.join(tempLoc, fileName + tempInd + ext), data).catch(error => {
                                console.error(error)
                            })
                        })
                        fileOptions['tempInds'][ext] = tempInd + 1
                        relativePath = path.join(pathPrepend, fileName + ext)
                    } else if ((fileName === 'mimetype'&& ext === '') || pathFromEpubRoot === 'META-INF') {
                        relativePath = path.join(pathFromEpubRoot, fileName + ext)
                    } else if (ext === ".xhtml") {
                        if (type === FileType.EXCLUSION || type === FileType.CHAPTER || type === FileType.OTHER) {
                            let newName = fileOptions.generateNewName(fileName, ePubName, type)['newName']
                            relativePath = path.join(finalPath, newName + ext)
                        } else {
                            continue
                        }
                    } else {
                        relativePath = path.join(finalPath, fileName + ext)
                    }
                    await extractAndRecordFile(fileOptions, zip, subFile.name, writeTo, relativePath)
                }
            }
        })
    }).catch(error => {
        console.error('Error reading file:', error)
    })
}

async function extractAndRecordFile(fileOptions, zip, fileName, writeTo, relativePath) {
    let downloadPath = path.join(writeTo, relativePath)
    let parts = path.parse(downloadPath)
    let type
    if (['.png', '.jpg', '.jpeg'].includes(parts.ext)) {
        type = 'nodebuffer'
    } else {
        type = 'text'
    }
    fileOptions['fileLocs'][parts.base] = relativePath
    if (!(await ff.checkPathExists(downloadPath))) {
        if (!(await ff.checkPathExists(parts.dir))) {
            await ff.generateDirectory(parts.dir)
        }
        await zip.file(fileName).async(type).then(async data => {
            await fs.writeFile(downloadPath, data).catch(error => {
                console.error(error)
            })
        })
    }
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
        const parentRegex = /^(<meta:EpubManip copyOfFinal=")(.*?)(">)(.*?)(<\/meta>.*)/s
        // const copyOfFinal = JSON.parse(parentRegex.exec(data)[2])
        const parentFile = parentRegex.exec(data)[4]
        const navPointRegex = /(.*?)(<navPoint.*?<\/navPoint>)(.*)/s
        const navPointIdRegex = /(.*id=")(.*?)(".*)/s
        const navPointPlayOrderRegex = /(.*playOrder=")(.*?)(".*)/s
        const navPointSrcRegex = /(.*src=")(.*?)(#.*)?(".*)/s
        let parsedForNavPoint = navPointRegex.exec(data)
        while (parsedForNavPoint) {
            let inNavXHTMLNode = false
            let isExclusion = false
            let ignoreWrite = false
            let exclusionName = ''
            let playOrderInection = ''
            remaining = parsedForNavPoint[3]
            let navPoint = parsedForNavPoint[2]
            let parsedForPlayOrder = navPointPlayOrderRegex.exec(navPoint)
            if (parsedForPlayOrder) {
                navPoint = `${parsedForPlayOrder[1]}${fileOptions['cumulativeData']['ncxInd']}${parsedForPlayOrder[3]}`
            } else {
                playOrderInection = `" playOrder="${fileOptions['cumulativeData']['ncxInd']}`
            }
            let parsedForId = navPointIdRegex.exec(navPoint)
            navPoint = `${parsedForId[1]}navPoint-${fileOptions['cumulativeData']['ncxInd']}${playOrderInection}${parsedForId[3]}`
            let parsedForSrc = navPointSrcRegex.exec(navPoint)
            let fileParts = ff.splitFileName(parsedForSrc[2])
            let [name, ext] = [fileParts.name, fileParts.ext]
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
            const dirKey = `${newName}${ext}`
            navPoint = `${parsedForSrc[1]}${fileOptions['fileDirs'][dirKey]}${parsedForSrc[3] || ''}${parsedForSrc[4]}`
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
        const parentRegex = /^(<meta:EpubManip copyOfFinal=")(.*?)(">)(.*?)(<\/meta>.*)/s
        const copyOfFinal = JSON.parse(parentRegex.exec(data)[2])
        const parentFile = parentRegex.exec(data)[4]
        const itemRegex = /(.*?)(<item .*?\/>)(.*)/s
        const itemHrefRegex = /(.*href=")(.*?)(".*)/s
        const itemIdRegex = /(.*id=")(.*?)(".*)/s
        const itemRefRegex = /(.*?)(<itemref.*?\/>)(.*)/s
        const itemRefIdRefRegex = /(.*idref=")(.*?)(".*)/s
        const referenceHrefRegex = /(.*?)(<reference.*?)(href=")(.*?)(#.*)?(".*?\/>)(.*)/s
        let parsedForItem = itemRegex.exec(data)
        while (parsedForItem) {
            let inNavXHTMLNode = false
            let isExclusion = false
            let isNcxNode = false
            let ignoreWrite = false
            let isOther = false
            let exclusionName = ''
            remaining = parsedForItem[3]
            let item = parsedForItem[2]
            let parsedForHref = itemHrefRegex.exec(item)
            const fileParts = ff.splitFileName(parsedForHref[2])
            let [dir, name, ext] = [fileParts.dir, fileParts.name, fileParts.ext]
            let newName = name
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
            let dirKey = `${newName}${ext}`
            item = `${parsedForHref[1]}${fileOptions['fileDirs'][dirKey]}${parsedForHref[3]}`
            let parsedforId = itemIdRegex.exec(item)
            const originalID = parsedforId[2]
            const newID = newName
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
        let parsedForItemRef = itemRefRegex.exec(remaining)
        while (parsedForItemRef) {
            remaining = parsedForItemRef[3]
            let item = parsedForItemRef[2]
            let parsedForItemRefIdRef= itemRefIdRefRegex.exec(item)
            let name = parsedForItemRefIdRef[2]
            if (spineRefs[name]) {
                fileOptions['cumulativeData']['opfSpineOther'].push(`${parsedForItemRefIdRef[1]}${spineRefs[name]}${parsedForItemRefIdRef[3]}`)
            }
            parsedForItemRef = itemRefRegex.exec(remaining)
        }
        if (copyOfFinal) {
            let parsedForReferenceHref = referenceHrefRegex.exec(remaining)
            while (parsedForReferenceHref) {
                remaining = parsedForReferenceHref[7]
                let fileParts = ff.splitFileName(parsedForReferenceHref[4])
                let dirKey = `${fileParts.name}${fileParts.ext}`
                fileOptions['cumulativeData']['opfReference'].push(`${parsedForReferenceHref[2]}${parsedForReferenceHref[3]}${fileOptions['fileDirs'][dirKey]}${parsedForReferenceHref[5] || ''}${parsedForReferenceHref[6]}`)
                parsedForReferenceHref = referenceHrefRegex.exec(remaining)
            }
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
        const liHrefRegex = /(.*href=")(.*?)(#.*)?(".*)/s
        let parsedForOl = olRegex.exec(data)
        const ol1 = parsedForOl[2]
        let parsedForLi = liRegex.exec(ol1)
        while (parsedForLi) {
            let inNavXHTMLNode = false
            let ignoreWrite = false
            let isExclusion = false
            let exclusionName = ''
            let item = parsedForLi[2]
            remaining = parsedForLi[3]
            let parsedForLiHref = liHrefRegex.exec(item)
            const fileParts = ff.splitFileName(parsedForLiHref[2])
            let [name, ext] = [fileParts.name, fileParts.ext]
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
                }
            }
            const dirKey = `${newName}${ext}`
            item = `${parsedForLiHref[1]}${fileOptions['fileDirs'][dirKey]}${parsedForLiHref[3] || ''}${parsedForLiHref[4]}`
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
                const fileParts = ff.splitFileName(parsedForLiHref[2])
                const [name, ext] = [fileParts.name, fileParts.ext]
                let newName = name
                if (ext) {
                    const savedName = ff.splitFileName(fileOptions['uniqueFileLocs']['xhtml']).name
                    if (name !== savedName) {
                        newName = fileOptions['renameHistory'][`${name}${parentFile}`]
                    }
                    const dirKey = `${newName}${ext}`
                    item = `${parsedForLiHref[1]}${fileOptions['fileDirs'][dirKey]}${parsedForLiHref[3] || ''}${parsedForLiHref[4]}`
                }
                fileOptions['cumulativeData']['contentsOL2'].push(item)
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
        const guideRegex = /(.*?<guide.*?>\s*)(.*?)(\s*<\/guide>.*)/s
        const parsedForManifest = manifestRegex.exec(data)
        const manifestData = [
            fileOptions['cumulativeData']['opfNCXLine'],
            fileOptions['cumulativeData']['opfContentsLine'],
            ...fileOptions['cumulativeData']['opfManifestData']
        ].join('\n')
        const parsedForSpine = spineRegex.exec(parsedForManifest[3])
        const spineData = fileOptions['cumulativeData']['opfSpineOther'].join('\n')
        const parsedForGuide = guideRegex.exec(parsedForSpine[3])
        const guideData = fileOptions['cumulativeData']['opfReference'].join('\n')
        data = `${parsedForManifest[1]}${manifestData}${parsedForSpine[1]}${spineData}${parsedForGuide[1]}${guideData}${parsedForGuide[3]}`
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

async function updateContainerXML(fileOptions) {
    try {
        let data = await fs.readFile(fileOptions['uniqueFileLocs']['xml'], {encoding: 'utf8'})
        const opfRegex = /(.*?full-path=")(.*?)(".*)/s
        const parsedForOPF = opfRegex.exec(data)
        const fileParts = ff.splitFileName(fileOptions['uniqueFileLocs']['opf'])
        const opfPath = path.join('OPS', `${fileParts.name}${fileParts.ext}`)
        data = `${parsedForOPF[1]}${opfPath}${parsedForOPF[3]}`
        await fs.writeFile(fileOptions['uniqueFileLocs']['xml'], data)
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

function fixXHTMLLinks(data, fileOptions) {
    const headRegex = /(.*?<head.*?>)(.*?)(<\/head>.*)/s
    const linkRegex = /(.*?)(<link.*?href=")(.*?)(".*?\/>)(.*)/s
    let parsedForHead = headRegex.exec(data)
    let parsedForLink = linkRegex.exec(parsedForHead[2])
    if (parsedForLink) {
        let parsedData = ''
        let remaining = ''
        while (parsedForLink) {
            const fileParts = ff.splitFileName(parsedForLink[3])
            const dirKey = `${fileParts.name}${fileParts.ext}`
            const newPath = path.join(path.sep, 'OPS', fileOptions['fileDirs'][dirKey])
            parsedData = `${parsedData}${parsedForLink[1]}${parsedForLink[2]}${newPath}${parsedForLink[4]}`
            remaining = parsedForLink[5]
            parsedForLink = linkRegex.exec(remaining)
        }
        data = `${parsedForHead[1]}${parsedData}${remaining}${parsedForHead[3]}`
    }
    return data
}

/**
 * Takes the contents of a .xhtml file and performs any desired replacments in the body.
 * @function processEpubFile
 * @param {String} data A string representing the contents of a .xhtml file.
 * @param {Object} fileOptions An object containing various options for epubs.
 * @returns {String} A string representing the updated file contents
 */
function processEpubFile(data, fileOptions) {
    if (fileOptions['replacements'].length === 0) {
        return data
    }
    const bodyRegex = /(.*?<body>\s*)(.*?)(\s*<\/body>.*)/s
    const parsedForBody = bodyRegex.exec(data)
    let processed = parsedForBody[2]
    for (let replacement of fileOptions['replacements']) {
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
    const chapters = []
    fileOptions['chapterFormat'] = fileOptions['chapterFormat'].filter(e => {
        if (chapters.includes(e['format'])) {
            return false
        } else {
            chapters.push(e['format'])
            return true
        }
    })
    const nonChapters = []
    fileOptions['nonChapterXHTML'] = fileOptions['nonChapterXHTML'].filter(e => {
        if (nonChapters.includes(e['fileName'])) {
            return false
        } else {
            nonChapters.push(e['fileName'])
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
 * @function cleanSubFolders
 * @param {String} ePubDir A string representing the folder in output to be deleted.
 * @returns {Promise<void>}
 */
async function cleanSubFolders(ePubDir) {
    const filePaths = [path.join(__dirname, 'output', ePubDir), path.join(__dirname, 'uploads', ePubDir)]
    for (let filePath of filePaths) {
        try {
            fs.rm(filePath, {recursive: true, force: true}).then(() => {
                console.log(`Directory ${filePath} deleted successfully!`)
            }).catch(error => {
                console.error(error)
            })
        } catch (error) {
            console.error(`Error deleting directory: ${filePath}!`)
        }
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

async function removeTempManip(ePubDir) {
    try {
        await fs.rm(path.join(__dirname, 'output', ePubDir, '_tempmanip_'), {recursive: true, force: true})
    } catch (error) {
        console.error(`Error deleting _tempmanip_ folder in ${ePubDir}`)
    }
    

}

function generateFileOptions(fileOptionsJSON) {
    const fileOptions = JSON.parse(fileOptionsJSON)
    cleanFileOptions(fileOptions)
    fileOptions['bodyInd'] = 0
    fileOptions['fileInds'] = {'xhtml': 0, 'opf': 0, 'ncx': 0}
    fileOptions['renameHistory'] = {}
    fileOptions['replacementData'] = {
        'renameInds': {
            'chaptersInd': 1,
            'othersInd': 1,
            'exclusionsInd': 1,
            },
        'chapters': [],
        'others': [],
        'exclusions': {}
    }
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
        'opfReference': [],
        'contentsRecordedExclusions': {},
        'contentsOL1': [],
        'contentsOL2': []
    }
    fileOptions['tempInds'] = {'.opf': 0, '.ncx': 0, '.xhtml': 0}
    fileOptions['uniqueFileLocs'] = {'.opf': '', '.ncx': '', '.xhtml': '', 'xml': ''}
    fileOptions['fileLocs'] = {}
    fileOptions['hasIgnore'] = function(name) {
        for (let file of this.ignoreFile) {
            if (file.fileName === name) {
                return true
            }
        }
        return false;
    }
    fileOptions['hasNav'] = function(name) {
        for (let file of this.xhtmlNav) {
            if (file.format === name) {
                return true
            }
        }
        return false
    }
    fileOptions['hasNonChapterXHTML'] = function(name) {
        for (let file of this.nonChapterXHTML) {
            if (file.fileName === name) {
                return true
            }
        }
        return false
    }
    fileOptions['hasChapterFormat'] = function(name) {
        name = name.replaceAll(/[0-9]/gi, '')
        for (let file of this.chapterFormat) {
            if (file.format === name) {
                return true
            }
        }
        return false
    }
    fileOptions['getFileType'] = function(name) {
        if (this.hasIgnore(name)) {
            return FileType.IGNORE
        } else if (this.hasNav(name)) {
            return FileType.NAVIGATION
        } else if (this.hasNonChapterXHTML(name)) {
            return FileType.EXCLUSION
        } else if (this.hasChapterFormat(name)) {
            return FileType.CHAPTER
        } else {
            return FileType.OTHER
        }
    }
    fileOptions['generateChapterName'] = function(originalName, parentEpub) {
        let chaptersInd = this['replacementData']['renameInds']['chaptersInd']
        let newName = CHAPTER_RENAME + chaptersInd
        this['replacementData']['renameInds']['chaptersInd'] = chaptersInd + 1
        let entry = {
            originalName: originalName,
            newName: newName,
            parentEpub: parentEpub
        }
        this['replacementData']['chapters'].push(entry)
        return entry
    }
    fileOptions['generateExclusionName'] = function(originalName, parentEpub) {
        entry = this['replacementData']['exclusions'][originalName]
        if (!entry) {
            let exclusionsInd = this['replacementData']['renameInds']['exclusionsInd']
            let newName = EXCLUSION_RENAME + exclusionsInd
            this['replacementData']['renameInds']['exclusionsInd'] = exclusionsInd + 1
            entry = {
                originalName: originalName,
                newName: newName,
                parentEpub: parentEpub
            }
            this['replacementData']['exclusions'][originalName] = entry
        }
        return entry
    }
    fileOptions['generateOtherName'] = function(originalName, parentEpub) {
        let othersInd = this['replacementData']['renameInds']['othersInd']
        let newName = OTHER_RENAME + othersInd
        this['replacementData']['renameInds']['othersInd'] = othersInd + 1
        let entry = {
            originalName: originalName,
            newName: newName,
            parentEpub: parentEpub
        }
        this['replacementData']['others'].push(entry)
        return entry
    }
    fileOptions['generateNewName'] = function(originalName, parentEpub, type) {
        if (type === FileType.CHAPTER) {
            return this.generateChapterName(originalName, parentEpub)
        } else if (type === FileType.EXCLUSION) {
            return this.generateExclusionName(originalName, parentEpub)
        } else if (type === FileType.OTHER) {
            return this.generateOtherName(originalName, parentEpub)
        } else {
            console.error(`Invalid FileType ${type} supplied to generateNewName`)
            return null
        }
    }
    return fileOptions
}

app.use(cors({
    origin: frontend
}))

app.post('/uploads', upload.array('myFiles', 100), async (request, response) => {
    if (request.files && request.files.length > 0) {
        const files = request.files.filter(file => {
            return ff.splitFileName(file.originalname).ext === '.epub'
        })
        const uploadTime = Date.now();
        for (let file of files) {
            file.filename = uploadTime + '-' + file.originalname.replaceAll(' ', '_')
        }
        if (files.length > 0) {
            const ePubDir = files[0].filename
            await generateSubFolders(ePubDir)
            const fileOptions = generateFileOptions(request.body['fileOptions'])
            for (let file of files) {
                await fs.writeFile(path.join(__dirname, 'uploads', ePubDir, file.filename), file.buffer).catch(error => {
                    console.error(error)
                })
                // await populateEpubDirectory(ePubDir, file.filename, fileOptions)
                await populateEpubDirectory(fileOptions, ePubDir, file.filename, fileOptions)
            }
            // await combineUniqueFiles(ePubDir, fileOptions)
            // await transplantCombinedFileData(fileOptions)
            // await updateContainerXML(fileOptions)
            // // console.log(fileOptions)
            // // await removeTempManip(ePubDir)
            // await generateEpub(ePubDir)
            // // cleanSubFolders(ePubDir)
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
            // cleanFinished(request.params.id)
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

module.exports = app