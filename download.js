var path = require('path')
var fs = require('fs')
var get = require('simple-get')
var pump = require('pump')
var tfs = require('tar-fs')
var noop = require('noop-logger')
var zlib = require('zlib')
var util = require('./util')
var error = require('./error')
var exec = require('child_process').exec

function transformElectron (opts, cb) {
  if (!opts.rc.electron) return process.nextTick(cb)

  var log = opts.log
  var local = './node_modules/.bin/electron'
  fs.stat(local, function (err) {
    var electron = err
      ? 'electron'
      : local

    log.info('fetching electron abi from "' + electron + '"')
    ask(electron)
  })

  function ask (electron) {
    var script = '/tmp/electron_abi.js'
    var src = 'console.log(process.versions.modules);process.exit(0)'
    fs.writeFile(script, src, function (err) {
      if (err) return cb(err)
      var cmd = electron + ' --require ' + script
      exec(cmd, function (err, stdout, stderr) {
        if (err) return cb(err)
        if (stderr.length) return cb(new Error(stderr.toString()))

        var abi = Number(stdout.toString())
        log.info('found electron abi version ' + abi)
        opts.rc.abi = abi
        cb()
      })
    })
  }
}

function downloadPrebuild (opts, cb) {
  var downloadUrl = util.getDownloadUrl(opts)
  var cachedPrebuild = util.cachedPrebuild(downloadUrl)
  var localPrebuild = util.localPrebuild(downloadUrl)
  var tempFile = util.tempFile(cachedPrebuild)

  var log = opts.log || noop

  if (opts.nolocal) return download()

  log.info('looking for local prebuild @', localPrebuild)
  fs.exists(localPrebuild, function (exists) {
    if (exists) {
      log.info('found local prebuild')
      cachedPrebuild = localPrebuild
      return unpack()
    }

    download()
  })

  function download () {
    ensureNpmCacheDir(function (err) {
      if (err) return onerror(err)

      log.info('looking for cached prebuild @', cachedPrebuild)
      fs.exists(cachedPrebuild, function (exists) {
        if (exists) {
          log.info('found cached prebuild')
          return unpack()
        }

        log.http('request', 'GET ' + downloadUrl)
        var req = get(downloadUrl, function (err, res) {
          if (err) return onerror(err)
          log.http(res.statusCode, downloadUrl)
          if (res.statusCode !== 200) return onerror()
          fs.mkdir(util.prebuildCache(), function () {
            log.info('downloading to @', tempFile)
            pump(res, fs.createWriteStream(tempFile), function (err) {
              if (err) return onerror(err)
              fs.rename(tempFile, cachedPrebuild, function (err) {
                if (err) return cb(err)
                log.info('renaming to @', cachedPrebuild)
                unpack()
              })
            })
          })
        })

        req.setTimeout(30 * 1000, function () {
          req.abort()
        })
      })

      function onerror (err) {
        fs.unlink(tempFile, function () {
          cb(err || error.noPrebuilts(opts))
        })
      }
    })
  }

  function unpack () {
    var binaryName

    var updateName = opts.updateName || function (entry) {
      if (/\.node$/i.test(entry.name)) binaryName = entry.name
    }

    log.info('unpacking @', cachedPrebuild)
    pump(fs.createReadStream(cachedPrebuild), zlib.createGunzip(), tfs.extract(opts.path, {readable: true, writable: true}).on('entry', updateName), function (err) {
      if (err) return cb(err)
      if (!binaryName) return cb(error.invalidArchive())

      var resolved
      try {
        resolved = path.resolve(opts.path || '.', binaryName)
      } catch (err) {
        return cb(err)
      }
      log.info('unpack', 'resolved to ' + resolved)

      if (opts.abi === process.versions.modules) {
        try {
          require(resolved)
        } catch (err) {
          return cb(err)
        }
        log.info('unpack', 'required ' + resolved + ' successfully')
      }
      cb(null, resolved)
    })
  }

  function ensureNpmCacheDir (cb) {
    var cacheFolder = util.npmCache()
    if (fs.access) {
      fs.access(cacheFolder, fs.R_OK | fs.W_OK, function (err) {
        if (err && err.code === 'ENOENT') {
          return makeNpmCacheDir()
        }
        cb(err)
      })
    } else {
      fs.exists(cacheFolder, function (exists) {
        if (!exists) return makeNpmCacheDir()
        cb()
      })
    }

    function makeNpmCacheDir () {
      log.info('npm cache directory missing, creating it...')
      fs.mkdir(cacheFolder, cb)
    }
  }
}

module.exports = function (opts, cb) {
  transformElectron(opts, function (err) {
    if (err) return cb(err)
    downloadPrebuild(opts, cb)
  })
}

