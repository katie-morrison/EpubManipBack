const ff = require('../util/file-functions')

describe('splitFileName', () => {
    it('returns empty values when given empty string', () => {
        const inp = ''
        const [exDir, exName, exExt] = ['', '', '']
        const out = ff.splitFileName(inp)
        expect(out).toStrictEqual({dir:exDir, name: exName, ext: exExt})
    })

    it('throws error if passed a .', () => {
        const inp = '.'
        expect(() => ff.splitFileName(inp)).toThrow('Invalid file name: .')
    })

    it('returns full input as directoryif passed a /', () => {
        const inp = '/'
        const [exDir, exName, exExt] = ['/', '', '']
        const out = ff.splitFileName(inp)
        expect(out).toStrictEqual({dir:exDir, name: exName, ext: exExt})
    })

    it('returns the full input as dir if passed a directory format', () => {
        const inp = 'test/'
        const [exDir, exName, exExt] = ['test/', '', '']
        const out = ff.splitFileName(inp)
        expect(out).toStrictEqual({dir:exDir, name: exName, ext: exExt})
    })

    it('returns the full input as dir if passed a directory format with multiple layers', () => {
        const inp = 'home/documents/github/project/final/directory/'
        const [exDir, exName, exExt] = ['home/documents/github/project/final/directory/', '', '']
        const out = ff.splitFileName(inp)
        expect(out).toStrictEqual({dir:exDir, name: exName, ext: exExt})
    })

    it('returns the full input as name if passed a .file', () => {
        const inp = '.gitignore'
        const [exDir, exName, exExt] = ['', '.gitignore', '']
        const out = ff.splitFileName(inp)
        expect(out).toStrictEqual({dir:exDir, name: exName, ext: exExt})
    })

    it('returns the full input as name if passed only a name', () => {
        const inp = 'mimetype'
        const [exDir, exName, exExt] = ['', 'mimetype', '']
        const out = ff.splitFileName(inp)
        expect(out).toStrictEqual({dir:exDir, name: exName, ext: exExt})
    })

    it('splits directory and .file', () => {
        const inp = 'dir/.gitignore'
        const [exDir, exName, exExt] = ['dir/', '.gitignore', '']
        const out = ff.splitFileName(inp)
        expect(out).toStrictEqual({dir:exDir, name: exName, ext: exExt})
    })

    it('splits directory and extensionless name', () => {
        const inp = 'dir/app'
        const [exDir, exName, exExt] = ['dir/', 'app', '']
        const out = ff.splitFileName(inp)
        expect(out).toStrictEqual({dir:exDir, name: exName, ext: exExt})
    })

    it('splits directory and extensioned name', () => {
        const inp = 'output/app.js'
        const [exDir, exName, exExt] = ['output/', 'app', '.js']
        const out = ff.splitFileName(inp)
        expect(out).toStrictEqual({dir:exDir, name: exName, ext: exExt})
    })

    it('splits layered directory and extensioned name', () => {
        const inp = 'documents/github/project2485/readme.md'
        const [exDir, exName, exExt] = ['documents/github/project2485/', 'readme', '.md']
        const out = ff.splitFileName(inp)
        expect(out).toStrictEqual({dir:exDir, name: exName, ext: exExt})
    })

    it('splits properly with directories containing .s', () => {
        const inp = 'test.wip.final/output.txt'
        const [exDir, exName, exExt] = ['test.wip.final/', 'output', '.txt']
        const out = ff.splitFileName(inp)
        expect(out).toStrictEqual({dir:exDir, name: exName, ext: exExt})
    })

    it('splits properly with files containing .s', () => {
        const inp = 'docs/wip.1.12.final.xhtml'
        const [exDir, exName, exExt] = ['docs/', 'wip.1.12.final', '.xhtml']
        const out = ff.splitFileName(inp)
        expect(out).toStrictEqual({dir:exDir, name: exName, ext: exExt})
    })
})