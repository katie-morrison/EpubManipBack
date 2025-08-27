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
 * @param {Array<Object>} fileList A list of objects representing files added to the folder.
 * @returns {Promise<void>}
 */
async function populateEpubDirectory(ePubDir, fileName, fileOptions, fileList) {
    const epubPath = path.join(__dirname, 'uploads', fileName)
    const promises = []
    await fs.readFile(epubPath).then(async data => {
        const zip = new JSZip()
        await zip.loadAsync(data).then(async epub => {
            for (let prop of Object.getOwnPropertyNames(epub.files)) {
                const file = epub.files[prop]
                if (!file.dir) {
                    const fileParts = ff.splitFileName(file.name)
                    let [dir, finalName, ext] = [fileParts.dir, fileParts.name, fileParts.ext]
                    let filePath = path.join(__dirname, 'output', ePubDir, dir)
                    let isBody = false
                    let isBeforeChapters = false
                    let isIncludedXHTML = false
                    let descriptor = 'Default descriptor'
                    if (ext === '.xhtml') {
                        const nonChapterEntry = nonChapterXHTMLIncludes(fileOptions, finalName)
                        if (nonChapterEntry) {
                            isBeforeChapters = nonChapterEntry.isBeforeChapters
                            isIncludedXHTML = true
                            descriptor = nonChapterEntry.descriptor
                        } else {
                            for (let bodyName of fileOptions.chapterFormat) {
                                if (finalName.includes(bodyName.format)) {
                                    finalName = `${bodyName.format}${fileOptions.bodyInd}`
                                    filePath = path.join(__dirname, 'output', ePubDir, dir)
                                    fileOptions['bodyInd']++
                                    isBody = true
                                    isIncludedXHTML = true
                                    break
                                }
                            }
                        }
                    }
                    if (ext !== '.ncx' && !(ext === '.xhtml' && !isIncludedXHTML)) {
                        if (!(await ff.checkPathExists(filePath))) {
                            await ff.generateDirectory(filePath)
                        }
                        filePath = path.join(filePath, `${finalName}${ext}`)
                        if (!(await ff.checkPathExists(filePath))) {
                            let type
                            if (['.png', '.jpg', '.jpeg'].includes(ext)) {
                                type = 'nodebuffer'
                            } else {
                                type = 'text'
                            }
                            let prom = zip.file(file.name).async(type).then(async data => {
                                if (ext === '.xhtml') {
                                    data = processEpubFile(data, fileOptions.replacements)
                                }
                                await fs.writeFile(filePath, data).then(() => {
                                    fileList.push({
                                        name: finalName,
                                        dir: dir,
                                        ext: ext,
                                        isBody: isBody,
                                        isBeforeChapters: isBeforeChapters,
                                        descriptor: descriptor
                                    })
                                }).catch(error => {
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

/**
 * Checks fileOptions to see if the named file should be handled differently from a normal chapter.
 * Returns the object containing settings for that file if a match is found, otherwise returns false
 * @function nonChapterXHTMLIncludes
 * @param {Object} fileOptions An object with settings for handling specific files.
 * @param {String} isolated A string representing a file name.
 * @returns {(Object|boolean)}
 */
function nonChapterXHTMLIncludes(fileOptions, isolated) {
    for (let entry of fileOptions.nonChapterXHTML) {
        if (entry.format === isolated) {
            return entry
        }
    }
    return false
}

/**
 * Generates a 'contents.xhtml' file for the epub being created.
 * @function generateTOCXHTML
 * @param {String} ePubDir A string representing the name of the folder to pull epub files from.
 * @param {Array<Object>} fileList An array of objects representing the files added to a given epub folder.
 * @returns {Promise<void>}
 */
async function generateTOCXHTML(ePubDir, fileList){
    try {
        const lineArr = []
        const data = await fs.readFile(path.join(__dirname, 'templates', 'contents.xhtml'), {encoding: 'utf8'})
        const lines = data.split(/\r?\n/)
        let firstChapter = undefined
        for (let line of lines) {
            let ind = line.indexOf('TOCLIST1')
            if (ind !== -1) {
                for (let file of fileList) {
                    if (file.order !== -1) {
                        if (file.chapterNumber !== -1) {
                            if (firstChapter === undefined) {
                                firstChapter = file
                            }
                            lineArr.push(`\t<li><a href="${file.name}${file.ext}">CHAPTER ${file.chapterNumber}</a></li>`)
                        } else {
                            lineArr.push(`\t<li><a href="${file.name}${file.ext}">${file.descriptor}</a></li>`)
                        }
                    }
                }
            } else {
                ind = line.indexOf('TOCLIST2')
                if (ind !== -1) {
                    lineArr.push(`\t\t<li><a epub:type="bodymatter" href="${firstChapter.name}${firstChapter.ext}">Start of Content</a></li>`)
                } else {
                    lineArr.push(line)
                }
            }
        }
        const filePath = path.join(__dirname, 'output', ePubDir, firstChapter.dir, 'contents.xhtml')
        await fs.writeFile(filePath, lineArr.join('\n'))
        fileList.push({
            name: 'contents',
            dir: firstChapter.dir,
            ext: '.xhtml',
            isBody: false,
            isBeforeChapters: false,
            descriptor: 'Default descriptor',
            order: -1,
            chapterNumber: -1
        })
    } catch (error) {
        console.error(error)
    }
}

/**
 * Generates a 'toc.ncx' file for the epub being created.
 * @function generateTOCNCX
 * @param {String} ePubDir A string representing the name of the folder to pull epub files from.
 * @param {Array<Object>} fileList An array of objects representing the files added to a given epub folder.
 * @returns {Promise<void>}
 */
async function generateTOCNCX(ePubDir, fileList){
    try {
        const lineArr = []
        const data = await fs.readFile(path.join(__dirname, 'templates', 'toc.ncx'), {encoding: 'utf8'})
        const lines = data.split(/\r?\n/)
        let firstChapter = undefined
        for (let line of lines) {
            let ind = line.indexOf('TOCLIST')
            if (ind !== -1) {
                for (let file of fileList) {
                    if (file.order !== -1) {
                        lineArr.push(`\t<navPoint id="navPoint-${file.order}" playOrder="${file.order}">`)
                        lineArr.push('\t\t<navLabel>')
                        if (file.chapterNumber !== -1) {
                            if (firstChapter === undefined) {
                                firstChapter = file
                            }
                            lineArr.push(`\t\t\t<text>Chapter ${file.chapterNumber}</text>`)
                        } else {
                            lineArr.push(`\t\t\t<text>${file.descriptor}</text>`)
                        }
                        lineArr.push('\t\t</navLabel>')
                        lineArr.push(`\t\t<content src="${file.name}${file.ext}"/>`)
                        lineArr.push('\t</navPoint>')
                    }
                }
            } else {
                lineArr.push(line)
            }
        }
        await fs.writeFile(path.join(__dirname, 'output', ePubDir, firstChapter.dir, 'toc.ncx'), lineArr.join('\n'))
        fileList.push({
            name: 'toc',
            dir: firstChapter.dir,
            ext: '.ncx',
            isBody: false,
            isBeforeChapters: false,
            descriptor: 'Default descriptor',
            order: -1,
            chapterNumber: -1
        })
    } catch (error) {
        console.error(error)
    }
}

/**
 * Updates the .opf file pulled from the initial epub.
 * @function updateOPF
 * @param {String} ePubDir A string representing the name of the folder to pull epub files from.
 * @param {Array<Object>} fileList An array of objects representing the files added to a given epub folder.
 * @param {String} title A string representing the title of the epub.
 * @returns {Promise<void>}
 */
async function updateOPF(ePubDir, fileList, title){
    try {
        const lineArr = []
        let inManifest = false
        let inSpine = false
        let opf = undefined
        for (let file of fileList) {
            if (file.ext === '.opf') {
                opf = file
                break
            }
        }
        const data = await fs.readFile(path.join(__dirname, 'output', ePubDir, opf.dir, opf.name + opf.ext), {encoding: 'utf8'})
        const lines = data.split(/\r?\n/)
        for (let line of lines) {
            let ind = line.indexOf('<manifest')
            if (ind !== -1) {
                inManifest = true
                lineArr.push(line)
                for (let file of fileList) {
                    if (file.ext === '.ncx') {
                        lineArr.push(`\t\t<item id="ncx" href="${file.dir.replace(opf.dir, '')}${file.name}${file.ext}" media-type="application/x-dtbncx+xml" fallback="contents"/>`)
                    } else if (file.ext === '.xhtml') {
                        if (file.name === 'contents') {
                            lineArr.push(`\t\t<item id="contents" properties="nav" href="${file.dir.replace(opf.dir, '')}${file.name}${file.ext}" media-type="application/xhtml+xml"/>`)
                        } else {
                            lineArr.push(`\t\t<item id="${file.name}" href="${file.dir.replace(opf.dir, '')}${file.name}${file.ext}" media-type="application/xhtml+xml"/>`)
                        }
                    } else if (file.ext === '.png') {
                        lineArr.push(`\t\t<item id="png-${file.name}" href="${file.dir.replace(opf.dir, '')}${file.name}${file.ext}" media-type="image/png"/>`)
                    } else if (file.ext === '.css') {
                        lineArr.push(`\t\t<item id="css-${file.name}" href="${file.dir.replace(opf.dir, '')}${file.name}${file.ext}" media-type="text/css"/>`)
                    } else if (file.ext === '.jpeg') {
                        lineArr.push(`\t\t<item id="jpeg-${file.name}" href="${file.dir.replace(opf.dir, '')}${file.name}${file.ext}" media-type="image/jpeg"/>`)
                    }
                }
            } else {
                ind = line.indexOf('<spine')
                if (ind !== -1) {
                    inSpine = true
                    lineArr.push(line)
                    lineArr.push('\t\t<itemref idref="contents" linear="yes"/>')
                    for (let file of fileList) {
                        if (file.ext === '.xhtml' && file.name !== 'contents') {
                            lineArr.push(`\t\t<itemref idref="${file.name}" linear="yes"/>`)
                        }
                    }
                } else {
                    ind = line.indexOf('<reference')
                    if (ind !== -1) {
                        lineArr.push('\t\t<reference type="toc" title="Contents" href="contents.xhtml"/>')
                    } else {
                        ind = line.indexOf('<dc:title')
                        if (ind !== -1) {
                            lineArr.push(`\t\t<dc:title>${title}</dc:title>`)
                        } else {
                            ind = line.indexOf('</manifest>')
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
            }
        }
        await fs.writeFile(path.join(__dirname, 'output', ePubDir, opf.dir, opf.name + opf.ext), lineArr.join('\n'))
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
 * Establishes the order files should be added to the table of contents.
 * This is primarily for ensuring all the chapters are together, and all titles, forewards, etc. are clumped before the chapters, while all afterwords, etc. are clumped after the chapters.
 * @function establishFileOrder
 * @param {Array<Object>} fileList An array of objects representing files pulled from the uploaded epubs.
 */
function establishFileOrder(fileList) {
    fileList.sort((a,b) => {
        return a.name.localeCompare(b.name)
    })

    let beforeChapters = 0
    let chapters = 0
    let beforeCount = 0
    let chapterCount = 0
    let afterCount = 0
    for (let file of fileList) {
        if (file.ext === '.xhtml') {
            if (file.isBody) {
                chapters++
            } else if (file.isBeforeChapters) {
                beforeChapters++
            }
        }
    }
    for (let file of fileList) {
        if (file.ext === '.xhtml') {
            if (file.isBody) {
                file.order = beforeChapters + chapterCount + 1
                file.chapterNumber = chapterCount + 1
                chapterCount++
            } else if (file.isBeforeChapters) {
                file.order = beforeCount + 1
                file.chapterNumber = -1
                beforeCount++
            } else {
                file.order = beforeChapters + chapters + afterCount + 1
                file.chapterNumber = -1
                afterCount++
            }
        } else {
            file.order = -1
            file.chapterNumber = -1
        }
    }

    fileList.sort((a,b) => {
        return a.order - b.order
    })
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
 * @param {String} ePubDir A string representing he name of the epub in uploads, and folder in output to be deleted.
 * @param {Array<String>} names An array of strings representing the names of files to be removed from the uploads directory.
 * @returns {Promise<void>}
 */
async function cleanUploads(ePubDir, names) {
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
            const ePubDir = files[0].filename
            const names = []
            const fileList = []
            await generateEpubDirectory(ePubDir)
            for (let file of files) {
                names.push(file.filename)
                await populateEpubDirectory(ePubDir, file.filename, fileOptions, fileList)
            }
            establishFileOrder(fileList)
            await generateTOCXHTML(ePubDir, fileList)
            await generateTOCNCX(ePubDir, fileList)
            await updateOPF(ePubDir, fileList, fileOptions.outputName)
            await generateEpub(ePubDir)
            cleanUploads(ePubDir, names)
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