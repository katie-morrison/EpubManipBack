const ft = require('./file-type')
const ff = require('./file-functions')
const FileType = ft.FileType

const EXCLUSION_RENAME = 'exclusion'
const CHAPTER_RENAME = 'chapter'
const OTHER_RENAME = 'other'

class ReplacementData {
    constructor() {
        this.renameInds = {
        'chaptersInd': 1,
        'othersInd': 1,
        'exclusionsInd': 1,
        }
        this.chapters = []
        this.others = []
        this.exclusions = {}
        this.recordedFiles = {'.opf': {}, '.ncx': {}, '.xhtml': {}}
    }

    getChapterName(originalName, parentFileName) {
        for (let chapter of this.chapters) {
            if (chapter['originalName'] === originalName && chapter['parentEpub'] === parentFileName) {
                return chapter['newName']
            }
        }
        return null
    }

    getOtherName(originalName, parentFileName) {
        for (let other of this.others) {
            if (other['originalName'] === originalName && other['parentEpub'] === parentFileName) {
                return other['newName']
            }
        }
        return null
    }
}

class CumulativeData {
    constructor() {
        this.ncxContentNavPoint = ''
        this.ncxNavPoints = []
        this.ncxNavPointsNonChapters = []
        this.opfContentsElement = ''
        this.opfNCXElement = ''
        this.opfSpineToc = ''
        this.opfFallback = ''
        this.opfSpineData = []
        this.opfSpineNonChapters = []
        this.opfReferenceData = []
        this.opfManifestData = []
        this.opfSpineContents = ''
        this.contentsOL1Data = []
        this.contentsOL1NonChapters = []
        this.contentsOL2Data = []
    }

    mergeData() {
        if (this.ncxContentNavPoint) {
            this.ncxNavPointsNonChapters.unshift(this.ncxContentNavPoint)
            this.ncxContentNavPoint = ''
        }

        const finalNavPoints = []
        let navInd = 1
        let f = function(val) {
            let ind = navInd
            navInd++
            return `navPoint-${ind}" playOrder="${ind}`
        }
        const idRegex = /(id=")(.*?)(")/gs
        for (let navPoint of this.ncxNavPointsNonChapters) {
            navPoint = ff.processReplacements(navPoint, idRegex, 2, f)
            finalNavPoints.push(navPoint)
        }
        for (let navPoint of this.ncxNavPoints) {
            navPoint = ff.processReplacements(navPoint, idRegex, 2, f)
            finalNavPoints.push(navPoint)
        }
        this.ncxNavPoints = finalNavPoints
        this.ncxNavPointsNonChapters = []

        if (this.opfContentsElement) {
            this.opfManifestData.unshift(this.opfContentsElement)
            this.opfContentsElement = ''
        }

        if (this.opfNCXElement) {
            const fallbackRegex = /(fallback=")(.*?)(")/s
            let match = fallbackRegex.exec(this.opfNCXElement)
            if (match) {
                this.opfNCXElement = this.opfNCXElement.replace(match[0], match[1] + this.opfFallback + match[3])
            }
            this.opfManifestData.unshift(this.opfNCXElement)
            this.opfNCXElement = ''
        }

        if (this.opfSpineContents) {
            this.opfSpineNonChapters.unshift(this.opfSpineContents)
            this.opfSpineContents = ''
        }

        const finalSpineData = []
        finalSpineData.push(...this.opfSpineNonChapters)
        finalSpineData.push(...this.opfSpineData)
        this.opfSpineData = finalSpineData
        this.opfSpineNonChapters = []

        const finalContentsOL1 = []
        finalContentsOL1.push(...this.contentsOL1NonChapters)
        finalContentsOL1.push(...this.contentsOL1Data)
        this.contentsOL1Data = finalContentsOL1
        this.contentsOL1NonChapters = []
    }
}

class FileOptions {
    constructor(fileOptionsJSON) {
        const initOptions = JSON.parse(fileOptionsJSON)
        cleanFileOptions(initOptions)
        this.chapterFormat = initOptions.chapterFormat
        this.nonChapterXHTML = initOptions.nonChapterXHTML
        this.xhtmlNav = initOptions.xhtmlNav
        this.replacements = initOptions.replacements
        this.ignoreFile = initOptions.ignoreFile
        this.outputName = initOptions.outputName
        this.bodyInd = 0
        this.fileInds = {'xhtml': 0, 'opf': 0, 'ncx': 0}
        this.renameHistory = {}
        this.replacementData = new ReplacementData()
        this.cumulativeData = new CumulativeData()
        this.tempInds = {'.opf': 0, '.ncx': 0, '.xhtml': 0}
        this.uniqueFileLocs = {'.opf': '', '.ncx': '', '.xhtml': '', 'xml': ''}
        this.fileLocs = {}
    }

    hasIgnore(name) {
        for (let file of this.ignoreFile) {
            if (file.fileName === name) {
                return true
            }
        }
        return false;
    }

    hasNav(name) {
        for (let file of this.xhtmlNav) {
            if (file.format === name) {
                return true
            }
        }
        return false
    }

    hasNonChapterXHTML(name) {
        for (let file of this.nonChapterXHTML) {
            if (file.fileName === name) {
                return true
            }
        }
        return false
    }

    hasChapterFormat(name) {
        name = name.replaceAll(/[0-9]/gi, '')
        for (let file of this.chapterFormat) {
            if (file.format === name) {
                return true
            }
        }
        return false
    }

    getFileType(name) {
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

    generateChapterName(originalName, parentEpub) {
        let chaptersInd = this.replacementData.renameInds.chaptersInd
        let newName = CHAPTER_RENAME + chaptersInd
        this.replacementData.renameInds.chaptersInd = chaptersInd + 1
        let entry = {
            originalName: originalName,
            newName: newName,
            parentEpub: parentEpub
        }
        this.replacementData.chapters.push(entry)
        return entry
    }

    generateExclusionName(originalName, parentEpub) {
        let entry = this.replacementData.exclusions[originalName]
        if (!entry) {
            let exclusionsInd = this.replacementData.renameInds.exclusionsInd
            let newName = EXCLUSION_RENAME + exclusionsInd
            this.replacementData.renameInds.exclusionsInd = exclusionsInd + 1
            entry = {
                originalName: originalName,
                newName: newName,
                parentEpub: parentEpub
            }
            this.replacementData.exclusions[originalName] = entry
        }
        return entry
    }

    generateOtherName(originalName, parentEpub) {
        let othersInd = this.replacementData.renameInds.othersInd
        let newName = OTHER_RENAME + othersInd
        this.replacementData.renameInds.othersInd = othersInd + 1
        let entry = {
            originalName: originalName,
            newName: newName,
            parentEpub: parentEpub
        }
        this.replacementData.others.push(entry)
        return entry
    }

    generateNewName(originalName, parentEpub, type) {
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

    getNewNameFormats() {
        return {
            'chapter': CHAPTER_RENAME,
            'exclusion': EXCLUSION_RENAME,
            'other': OTHER_RENAME
        }
    }
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

    let replacements = fileOptions['replacements'].map(replacement => {
        replacement['before'] = replacement['before'].replaceAll(/[<>]/gs, '')
        replacement['after'] = replacement['after'].replaceAll(/[<>]/gs, '')
        return replacement
    })
    fileOptions['replacements'] = replacements.filter(replacement => {
        if (replacement['before'] === '' || replacement['after'] === '') {
            return false
        }
        return true
    })
}

module.exports = {FileOptions}