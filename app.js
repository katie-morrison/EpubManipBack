const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs/promises')
const multer = require('multer')
const JSZip = require('jszip')
const epubZip = require('epub-zip')
const frontend = require('./config/frontend')

const ff = require('./util/file-functions')
const fo = require('./util/file-options')
const ft = require('./util/file-type')

const app = express()
const storage = multer.memoryStorage()
const upload = multer({storage: storage})

const CONTAINER_NAME = 'EpubManipGenerated'

const FileType = ft.FileType

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
    fileOptions['cumulativeData'].mergeData()
}

async function harvestNCXData(filePath, fileOptions) {
    const data = await fs.readFile(filePath, {encoding: 'utf8'})
    const parentRegex = /^(<meta:EpubManip copyOfFinal=")(.*?)(">)(.*?)(<\/meta>.*)/s
    const parentFile = parentRegex.exec(data)[4]
    let navPoints = extractSections(data, /(\n*)(\s*)(<navPoint.*?<\/navPoint>)/gs, 0)

    for (let navPoint of navPoints) {
        navPoint = navPoint.replaceAll(/\splayOrder=".*?"/gs, '')

        renameInfo = handleNodeFileRename(fileOptions, navPoint, /(src=")(.*?)(#.*)?(")/s, 2, '.ncx', parentFile)
        
        if (!renameInfo.isNoMatch && !renameInfo.isIgnoreNode && !renameInfo.isUniqueFileAlreadyExists && renameInfo.type !== FileType.IGNORE) {
            navPoint = renameInfo.content
            type = renameInfo.type
            if (type === FileType.NAVIGATION) {
                if (!fileOptions['cumulativeData']['ncxContentNavPoint']) {
                    fileOptions['cumulativeData']['ncxContentNavPoint'] = navPoint
                }
            } else if (type === FileType.CHAPTER) {
                fileOptions['cumulativeData']['ncxNavPoints'].push(navPoint)
            } else if (type === FileType.OTHER || type === FileType.EXCLUSION) {
                fileOptions['cumulativeData']['ncxNavPointsNonChapters'].push(navPoint)
            }
        }
    }
}

async function harvestOPFData(filePath, fileOptions) {
    const data = await fs.readFile(filePath, {encoding: 'utf8'})
    const parentRegex = /^(<meta:EpubManip copyOfFinal=")(.*?)(">)(.*?)(<\/meta>)/s
    const copyOfFinal = JSON.parse(parentRegex.exec(data)[2])
    const parentFile = parentRegex.exec(data)[4]
    const spineRefs = {}

    let items = extractSections(data, /(\n*)(\s*)(<item .*?\/>)/gs, 0)
    for (let item of items) {
        renameInfo = handleNodeFileRename(fileOptions, item, /(href=")(.*?)(")/s, 2, '.opf', parentFile)

        if (!renameInfo.isNoMatch && !renameInfo.isIgnoreNode && !renameInfo.isUniqueFileAlreadyExists && renameInfo.type !== FileType.IGNORE) {
            let type = renameInfo.type
            let content = renameInfo.content
            let newId = path.parse(renameInfo.newPath).base
            const itemIdRegex = /(id=")(.*?)(")/s
            let match = itemIdRegex.exec(content)
            if (match) {
                spineRefs[match[2]] = {'newId': newId, 'type': type}
                content = content.replace(match[0], `id="${newId}"`)
                if (renameInfo.isNCXNode) {
                    fileOptions['cumulativeData']['opfNCXElement'] = content
                    fileOptions['cumulativeData']['opfSpineToc'] = newId
                } else if (type === FileType.NAVIGATION) {
                    fileOptions['cumulativeData']['opfContentsElement'] = content
                    fileOptions['cumulativeData']['opfFallback'] = newId
                } else {
                    fileOptions['cumulativeData']['opfManifestData'].push(content)
                }
            }
        }
    }

    let itemRefs = extractSections(data, /(\n*)(\s*)(<itemref.*?\/>)/gs, 0)
    for (let itemRef of itemRefs) {
        const itemRefIdRefRegex = /(idref=")(.*?)(")/s
        let match = itemRefIdRefRegex.exec(itemRef)
        if (match) {
            let ref = spineRefs[match[2]]
            if (ref) {
                let newName = ref['newId']
                let type = ref['type']
                itemRef = itemRef.replace(match[0], match[1] + newName + match[3])
                if (type === FileType.CHAPTER) {
                    fileOptions['cumulativeData']['opfSpineData'].push(itemRef)
                } else if (type === FileType.EXCLUSION || type === FileType.OTHER) {
                    fileOptions['cumulativeData']['opfSpineNonChapters'].push(itemRef)
                } else if (type === FileType.NAVIGATION) {
                    fileOptions['cumulativeData']['opfSpineContents'] = itemRef
                }
            }
        }
    }

    if (copyOfFinal) {
        let references = extractSections(data, /(\n*)(\s*)(<reference.*?\/>)/gs, 0)
        for (let reference of references) {
            let renameInfo = handleNodeFileRename(fileOptions, reference, /(href=")(.*?)(#.*)?(")/s, 2, '.opf', parentFile)
            if (!renameInfo.isNoMatch && renameInfo.type !== FileType.IGNORE) {
                fileOptions['cumulativeData']['opfReferenceData'].push(renameInfo.content)
            }
        }
    }
}

async function harvestContentsData(filePath, fileOptions) {
    const data = await fs.readFile(filePath, {encoding: 'utf8'})
    const parentRegex = /^(<meta:EpubManip copyOfFinal=")(.*?)(">)(.*?)(<\/meta>)/s
    const copyOfFinal = JSON.parse(parentRegex.exec(data)[2])
    const parentFile = parentRegex.exec(data)[4]

    let OLs = extractSections(data, /(<ol>.*?<\/ol>)/gs, 0)
    let OL1 = OLs[0]
    const liRegex = /(\n*)(\s*)(<li>.*?<\/li>)/gs
    const hrefRegex = /(href=")(.*?)(#.*)?(")/s
    let OL1LIs = extractSections(OL1, liRegex, 0)

    for (let LI of OL1LIs) {
        let renameInfo = handleNodeFileRename(fileOptions, LI, hrefRegex, 2, '.xhtml', parentFile)
        if (!renameInfo.isNoMatch && !renameInfo.isIgnoreNode && !renameInfo.isUniqueFileAlreadyExists && renameInfo.type !== FileType.IGNORE) {
            let type = renameInfo.type
            if (type === FileType.CHAPTER) {
                fileOptions['cumulativeData']['contentsOL1Data'].push(renameInfo.content)
            } else if (type === FileType.EXCLUSION || type === FileType.OTHER) {
                fileOptions['cumulativeData']['contentsOL1NonChapters'].push(renameInfo.content)
            }
        }
    }

    if (copyOfFinal) {
        let OL2 = OLs[1]
        let OL2LIs = extractSections(OL2, liRegex, 0)

        for (let LI of OL2LIs) {
            let renameInfo = handleNodeFileRename(fileOptions, LI, hrefRegex, 2, '.xhtml', parentFile)
            if (!renameInfo.isNoMatch && !renameInfo.isUniqueFileAlreadyExists && renameInfo.type !== FileType.IGNORE) {
                fileOptions['cumulativeData']['contentsOL2Data'].push(renameInfo.content)
            }
        }
    }
}

function extractSections(data, patternString, groupToExtract) {
    let ret = []
    let match

    while ((match = patternString.exec(data))) {
        ret.push(match[groupToExtract])
    }

    return ret
}

function handleNodeFileRename(fileOptions, content, patternString, groupToRename, parentExt, parentEpub) {
    ret = {}
    let match

    if ((match = patternString.exec(content))) {
        let originalPath = match[groupToRename]
        let parts = path.parse(originalPath)
        let [fileName, ext] = [parts.name, parts.ext]
        let type = fileOptions.getFileType(fileName)
        let newName = fileName

        //link to local element, e.g. href="#anchor"
        if (originalPath === '') {
            ret['isNoMatch'] = false
            ret['type'] = type
            ret['originalPath'] = originalPath
            ret['content'] = content
            return ret
        }

        if (ext === '.xhtml') {
            if (type === FileType.NAVIGATION) {
                if (parentExt === '.opf' && fileOptions['cumulativeData']['opfContentsElement']) {
                    ret['isUniqueFileAlreadyExists'] = true
                }
                let savedUniqueFileName = path.parse(fileOptions['uniqueFileLocs'][ext]).name
                if (savedUniqueFileName !== fileName) {
                    ret['isIgnoreNode'] = true
                }
            } else if (type === FileType.EXCLUSION) {
                newName = fileOptions['replacementData']['exclusions'][fileName]['newName']
            } else if (type === FileType.CHAPTER) {
                newName = fileOptions['replacementData'].getChapterName(fileName, parentEpub)
            } else if (type === FileType.OTHER) {
                newName = fileOptions['replacementData'].getOtherName(fileName, parentEpub)
            }
        } else if (ext === '.ncx') {
            ret['isNCXNode'] = true
            if (fileOptions['cumulativeData']['opfNCXElement']) {
                ret['isUniqueFileAlreadyExists'] = true
            }
            let savedUniqueFileName = path.parse(fileOptions['uniqueFileLocs'][ext]).name
            if (savedUniqueFileName !== fileName) {
                ret['isIgnoreNode'] = true
            }
        } else {
            //Other
        }

        if (type !== FileType.IGNORE) {
            newName = newName || fileName
            if (!fileOptions['replacementData']['recordedFiles'][parentExt][newName]) {
                fileOptions['replacementData']['recordedFiles'][parentExt][newName] = true
            } else {
                ret['isIgnoreNode'] = true
            }

            let replacement = fileOptions['fileLocs'][newName + ext]
            if (parentExt === '.opf') {
                replacement = replacement.replace(CONTAINER_NAME + path.sep, '')
            } else {
                replacement = `/${replacement}`
            }

            let before = match[0]
            let after = ''
            for (let i = 1; i <= match.length - 1; i++) {
                if (i === groupToRename) {
                    after = `${after}${replacement}`
                } else {
                    after = `${after}${match[i] ?? ''}`
                }
            }
            content = content.replace(before, after)

            ret['newPath'] = replacement
        }

        ret['isNoMatch'] = false
        ret['type'] = type
        ret['originalPath'] = originalPath
        ret['content'] = content
    } else {
        ret['content'] = content
        ret['isNoMatch'] = true
        ret['type'] = FileType.IGNORE
    }

    return ret
}

async function transplantCombinedFileData(fileOptions, ePubDir) {
    try {
        let data
        let next
        let f = function(val) {
            let ret = ''
            for (let i of next) {
                ret = `${ret}${i}`
            }
            return ret
        }
        if (fileOptions['uniqueFileLocs']['.ncx']) {
            const ncxPath = path.join(__dirname, 'output', ePubDir, fileOptions['uniqueFileLocs']['.ncx'])
            data = await fs.readFile(ncxPath, {encoding: 'utf8'})

            next = [fileOptions['outputName']]
            data = ff.processReplacements(data, /(<docTitle.*?<text>)(.*?)(\n*)(\s*)(<\/text>)/gs, 2, f)

            next = fileOptions['cumulativeData']['ncxNavPoints']
            data = ff.processReplacements(data, /(<navMap>)(.*?)(\n*)(\s*)(<\/navMap>)/gs, 2, f)

            await fs.writeFile(ncxPath, data)
        }
        if (fileOptions['uniqueFileLocs']['.opf']) {
            const opfPath = path.join(__dirname, 'output', ePubDir, fileOptions['uniqueFileLocs']['.opf'])
            data = await fs.readFile(opfPath, {encoding: 'utf8'})
            
            next = [fileOptions['outputName']]
            data = ff.processReplacements(data, /(<dc:title>)(.*?)(\n*)(\s*)(<\/dc:title>)/gs, 2, f)

            next = fileOptions['cumulativeData']['opfManifestData']
            data = ff.processReplacements(data, /(<manifest>)(.*?)(\n*)(\s*)(<\/manifest>)/gs, 2, f)

            next = [fileOptions['cumulativeData']['opfSpineToc']]
            data = ff.processReplacements(data, /(<spine.*?toc=")(.*?)(")/gs, 2, f)

            next = fileOptions['cumulativeData']['opfSpineData']
            data = ff.processReplacements(data, /(<spine.*?>)(.*?)(\n*)(\s*)(<\/spine>)/gs, 2, f)

            next = fileOptions['cumulativeData']['opfReferenceData']
            data = ff.processReplacements(data, /(<guide.*?>)(.*?)(\n*)(\s*)(<\/guide>)/gs, 2, f)

            await fs.writeFile(opfPath, data)
        }
        if (fileOptions['uniqueFileLocs']['.xhtml']) {
            const xhtmlPath = path.join(__dirname, 'output', ePubDir, fileOptions['uniqueFileLocs']['.xhtml'])
            data = await fs.readFile(xhtmlPath, {encoding: 'utf8'})
            
            next = fileOptions['cumulativeData']['contentsOL1Data']
            data = ff.processReplacements(data, /(<ol>)(.*?)(\n*)(\s*)(<\/ol>)(.*?)(<ol>)(.*?)(<\/ol>)/gs, 2, f)

            next = fileOptions['cumulativeData']['contentsOL2Data']
            data = ff.processReplacements(data, /(<ol>)(.*?)(<\/ol>)(.*?)(<ol>)(.*?)(\n*)(\s*)(<\/ol>)/gs, 6, f)

            await fs.writeFile(xhtmlPath, data)
        }
    } catch (error) {
        console.error(error)
    }

}

async function updateXMLandXHTMLFiles(fileOptions, ePubDir) {
    const dir = path.join(__dirname, 'output', ePubDir)
    const files = await fs.readdir(dir, {withFileTypes: true, recursive: true})
    for (let file of files) {
        if (file.isFile()) {
            const filePath = path.join(file.path, file.name)
            if (file.name === 'container.xml') {
                recalculateDirectory(fileOptions, filePath, true)
            } else if (path.parse(filePath).ext === '.xhtml') {
                await recalculateDirectory(fileOptions, filePath, false)
                if (path.join(__dirname, 'output', ePubDir, fileOptions['uniqueFileLocs']['.xhtml']) !== filePath) {
                    makeReplacements(fileOptions, filePath)
                }
            }
        }
    }
}

async function recalculateDirectory(fileOptions, filePath, isContainerXMLFile) {
    let data = await fs.readFile(filePath, {encoding: 'utf8'})
    if (isContainerXMLFile) {
        let f = function(val) {
            return fileOptions['uniqueFileLocs']['.opf']
        }
        data = ff.processReplacements(data, /(full-path=")(.*?)(")/gs, 2, f)
    } else {
        let f = function(val) {
            const oldName = path.parse(val).base
            return `/${fileOptions['fileLocs'][oldName]}`
        }
        data = ff.processReplacements(data, /(href=")(.*?)(#.*)?(")/gs, 2, f)
        data = ff.processReplacements(data, /(src=")(.*?)(#.*)?(")/gs, 2, f)
    }
    await fs.writeFile(filePath, data)
}

async function makeReplacements(fileOptions, filePath) {
    if (fileOptions['replacements'].length) {
        let data = await fs.readFile(filePath, {encoding: 'utf8'})
        const bodyRegex = /(<body>)(.*?)(<\/body>)/gs
        const contentRegex = /(>)(.*?)(<)/gs
        const match = bodyRegex.exec(data)
        if (match) {
            let body = match[2]
            for (let replacement of fileOptions['replacements']) {
                let f = function(val) {
                    return val.replaceAll(replacement['before'], replacement['after'])
                }
                body = ff.processReplacements(body, contentRegex, 2, f)
            }

            data = data.replace(match[0], `${match[1]}${body}${match[3]}`)
        }

        
        await fs.writeFile(filePath, data)
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
            const fileOptions = fo.generateFileOptions(request.body['fileOptions'])
            for (let file of files) {
                await fs.writeFile(path.join(__dirname, 'uploads', ePubDir, file.filename), file.buffer).catch(error => {
                    console.error(error)
                })
                // await populateEpubDirectory(ePubDir, file.filename, fileOptions)
                await populateEpubDirectory(fileOptions, ePubDir, file.filename, fileOptions)
            }
            await combineUniqueFiles(ePubDir, fileOptions)
            // await removeTempManip(ePubDir)
            await transplantCombinedFileData(fileOptions, ePubDir)
            await updateXMLandXHTMLFiles(fileOptions, ePubDir)
            // console.log(fileOptions)
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